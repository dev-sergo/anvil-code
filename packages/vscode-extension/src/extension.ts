import * as vscode from 'vscode';
import { RagApiClient } from './api-client.js';
import { ProjectsView } from './projects-view.js';
import { TasksView } from './tasks-view.js';
import { formatEventLine } from './format.js';
import type { TaskEvent } from '@rag-system/shared';

const ACTIVE_PROJECT_KEY = 'ragSystem.activeProjectId';

export function activate(context: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration('ragSystem');
  const api = new RagApiClient(cfg.get<string>('apiUrl', 'http://localhost:3000'));

  // Active-project state lives in workspaceState so each workspace remembers
  // its selection across reloads.
  let activeProjectId = context.workspaceState.get<string>(ACTIVE_PROJECT_KEY);
  const setActive = async (id: string | undefined) => {
    activeProjectId = id;
    await context.workspaceState.update(ACTIVE_PROJECT_KEY, id);
    projectStatusItem.text = `$(rocket) RAG: ${activeProjectName() ?? 'no project'}`;
    projectsView.refresh();
    tasksView.refresh();
  };
  const activeProjectName = () =>
    activeProjectId ? projectsView.current().find(p => p.id === activeProjectId)?.name : undefined;

  const output = vscode.window.createOutputChannel('RAG System', { log: true });
  context.subscriptions.push(output);

  const projectStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  projectStatusItem.command = 'rag.selectActiveProject';
  projectStatusItem.text = '$(rocket) RAG: ...';
  projectStatusItem.tooltip = 'Click to switch active RAG project';
  projectStatusItem.show();
  context.subscriptions.push(projectStatusItem);

  // Task status item appears only while a task is streaming.
  const taskStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  taskStatusItem.tooltip = 'Click to open the RAG System output channel';
  taskStatusItem.command = { command: 'rag.showOutput', title: 'Show RAG Output' };
  context.subscriptions.push(taskStatusItem);

  const projectsView = new ProjectsView(api, () => activeProjectId);
  const tasksView = new TasksView(api, () => activeProjectId);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('ragProjects', projectsView),
    vscode.window.registerTreeDataProvider('ragTasks', tasksView),
  );

  // Initial load — also picks the first project as active when nothing is set
  void (async () => {
    projectsView.refresh();
    await sleep(50); // let the initial reload settle so .current() is non-empty
    if (!activeProjectId) {
      const first = projectsView.current()[0];
      if (first) await setActive(first.id);
    } else {
      projectStatusItem.text = `$(rocket) RAG: ${activeProjectName() ?? activeProjectId.slice(0, 8)}`;
    }
    tasksView.refresh();
  })();

  // Periodic refresh of tasks so status (queued → running → completed) updates without manual action
  const intervalMs = cfg.get<number>('refreshIntervalMs', 5000);
  if (intervalMs > 0) {
    const timer = setInterval(() => tasksView.refresh(), intervalMs);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }

  // ── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('rag.refresh', () => {
      projectsView.refresh();
      tasksView.refresh();
    }),

    vscode.commands.registerCommand('rag.showOutput', () => output.show(true)),

    vscode.commands.registerCommand('rag.connect', async () => {
      const url = await vscode.window.showInputBox({
        prompt: 'RAG API URL',
        value: api.baseUrl,
      });
      if (!url) return;
      api.setBaseUrl(url);
      await cfg.update('apiUrl', url, vscode.ConfigurationTarget.Global);
      projectsView.refresh();
      tasksView.refresh();
    }),

    vscode.commands.registerCommand('rag.selectActiveProject', async (preselectedId?: string) => {
      let id = preselectedId;
      if (!id) {
        const projects = projectsView.current();
        const pick = await vscode.window.showQuickPick(
          projects.map(p => ({ label: p.name, description: p.id, id: p.id })),
          { placeHolder: 'Select active project' },
        );
        if (!pick) return;
        id = pick.id;
      }
      await setActive(id);
    }),

    vscode.commands.registerCommand('rag.registerProject', async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const defaultRoot = folders[0]?.uri.fsPath ?? '';
      const root = await vscode.window.showInputBox({
        prompt: 'Project root (absolute path)',
        value: defaultRoot,
      });
      if (!root) return;
      const name = await vscode.window.showInputBox({
        prompt: 'Display name (optional)',
        placeHolder: 'leave blank to use folder name',
      });
      try {
        const project = await api.registerProject(root, name || undefined);
        void vscode.window.showInformationMessage(`Registered '${project.name}' (${project.id.slice(0, 8)})`);
        projectsView.refresh();
        await setActive(project.id);
      } catch (err) {
        void vscode.window.showErrorMessage(`Register failed: ${String(err)}`);
      }
    }),

    vscode.commands.registerCommand('rag.runTask', async () => {
      // Pick project up front — falls back to active when present so the
      // hot path stays one ENTER for power users.
      let projectId = activeProjectId;
      if (!projectId) {
        const projects = projectsView.current();
        if (projects.length === 0) {
          void vscode.window.showWarningMessage('No projects registered. Use "RAG: Register Project" first.');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          projects.map(p => ({ label: p.name, description: p.root, id: p.id })),
          { placeHolder: 'Project for this task' },
        );
        if (!pick) return;
        projectId = pick.id;
      }
      const task = await vscode.window.showInputBox({
        prompt: 'Task description',
        placeHolder: 'e.g. add a CLI flag to disable colored output',
      });
      if (!task) return;
      const mode = await vscode.window.showQuickPick(['balanced', 'fast', 'deep'], {
        placeHolder: 'Mode',
      }) as 'balanced' | 'fast' | 'deep' | undefined;
      try {
        const r = await api.createTask({ task, mode: mode ?? 'balanced', project: projectId });
        void vscode.window.showInformationMessage(`Task ${r.task_id.slice(0, 8)} queued`);
        tasksView.refresh();
        // Auto-stream so the user sees progress immediately
        void streamToOutput(api, output, taskStatusItem, r.task_id, () => tasksView.refresh());
      } catch (err) {
        void vscode.window.showErrorMessage(`Submit failed: ${String(err)}`);
      }
    }),

    vscode.commands.registerCommand('rag.indexProject', async () => {
      if (!activeProjectId) {
        void vscode.window.showWarningMessage('Pick an active project first.');
        return;
      }
      try {
        const r = await api.indexProject(activeProjectId);
        void vscode.window.showInformationMessage(`Indexing started — id ${r.index_id.slice(0, 12)}`);
        void streamToOutput(api, output, taskStatusItem, r.index_id);
      } catch (err) {
        void vscode.window.showErrorMessage(`Index failed: ${String(err)}`);
      }
    }),

    vscode.commands.registerCommand('rag.streamTask', async (taskOrId?: string | { task?: { id: string } }) => {
      // Tree item passes the TaskItem through; quick-pick passes nothing.
      let id: string | undefined;
      if (typeof taskOrId === 'string') id = taskOrId;
      else if (taskOrId && typeof taskOrId === 'object' && 'task' in taskOrId) id = taskOrId.task?.id;
      if (!id) {
        id = await vscode.window.showInputBox({ prompt: 'Task or index id to stream' });
      }
      if (!id) return;
      void streamToOutput(api, output, taskStatusItem, id, () => tasksView.refresh());
    }),
  );
}

export function deactivate(): void {
  // OutputChannel and other disposables registered via context.subscriptions
  // are torn down by VSCode automatically.
}

/** Live-tracked summary of a stream, used to render the final notification. */
interface StreamSummary {
  fileCount: number;
  commitHash?: string;
  commitSkipped: boolean;
  partial: boolean;
  error?: string;
  done: boolean;
}

async function streamToOutput(
  api: RagApiClient,
  output: vscode.OutputChannel,
  statusItem: vscode.StatusBarItem,
  id: string,
  onTerminal?: () => void,
): Promise<void> {
  output.show(true);
  output.appendLine(`\n── streaming ${id} ──`);
  const shortId = id.slice(0, 8);
  statusItem.text = `$(sync~spin) RAG: ${shortId}`;
  statusItem.show();

  const summary: StreamSummary = { fileCount: 0, commitSkipped: false, partial: false, done: false };

  try {
    for await (const event of api.streamTask(id)) {
      output.appendLine(formatEventLine(event));
      updateStatusFromEvent(statusItem, shortId, event);
      mergeSummary(summary, event);
    }
    output.appendLine(`── stream ${id} closed ──`);
  } catch (err) {
    summary.error = String(err);
    output.appendLine(`stream error: ${String(err)}`);
  } finally {
    statusItem.hide();
    onTerminal?.();
    notifyTerminal(id, summary);
  }
}

function updateStatusFromEvent(item: vscode.StatusBarItem, shortId: string, event: TaskEvent): void {
  switch (event.type) {
    case 'queued':       item.text = `$(clock) RAG: ${shortId} queued`; break;
    case 'running':      item.text = `$(sync~spin) RAG: ${shortId} running`; break;
    case 'plan':         item.text = `$(sync~spin) RAG: ${shortId} planning`; break;
    case 'step_start':   item.text = `$(sync~spin) RAG: ${shortId} step`; break;
    case 'validation_start': item.text = `$(sync~spin) RAG: ${shortId} validate`; break;
    case 'commit':       item.text = `$(check) RAG: ${shortId} committed`; break;
    case 'index_file':   /* high-frequency, skip */ break;
    default: break;
  }
}

function mergeSummary(summary: StreamSummary, event: TaskEvent): void {
  const d = event.data as Record<string, unknown> | undefined;
  switch (event.type) {
    case 'commit':
      summary.fileCount = (d?.fileCount as number) ?? summary.fileCount;
      summary.commitHash = (d?.commitHash as string) ?? summary.commitHash;
      break;
    case 'commit_skipped':
      summary.fileCount = (d?.fileCount as number) ?? summary.fileCount;
      summary.commitSkipped = true;
      break;
    case 'commit_partial':
      summary.partial = true;
      break;
    case 'error':
      summary.error = event.message ?? 'unknown error';
      break;
    case 'done':
      summary.done = true;
      summary.partial = summary.partial || ((d?.partial as boolean) ?? false);
      break;
    default: break;
  }
}

function notifyTerminal(taskId: string, s: StreamSummary): void {
  const short = taskId.slice(0, 8);
  if (s.error) {
    void vscode.window.showErrorMessage(`RAG task ${short} failed: ${s.error}`);
    return;
  }
  if (!s.done) return; // stream closed without 'done' — already surfaced via Output

  const parts: string[] = [];
  if (s.commitHash) {
    parts.push(`committed ${s.fileCount} file(s) @ ${s.commitHash.slice(0, 8)}`);
  } else if (s.commitSkipped) {
    parts.push(`commit skipped (${s.fileCount} file(s) on auto-branch)`);
  } else if (s.fileCount > 0) {
    parts.push(`${s.fileCount} file(s) changed`);
  } else {
    parts.push('no files changed');
  }
  if (s.partial) parts.push('partial');
  void vscode.window.showInformationMessage(`RAG task ${short}: ${parts.join(' · ')}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
