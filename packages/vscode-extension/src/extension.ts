import * as vscode from 'vscode';
import { RagApiClient } from './api-client.js';
import { ProjectsView } from './projects-view.js';
import { TasksView } from './tasks-view.js';
import { formatEventLine } from './format.js';

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
    statusItem.text = `$(rocket) RAG: ${activeProjectName() ?? 'no project'}`;
    projectsView.refresh();
    tasksView.refresh();
  };
  const activeProjectName = () =>
    activeProjectId ? projectsView.current().find(p => p.id === activeProjectId)?.name : undefined;

  const output = vscode.window.createOutputChannel('RAG System', { log: true });
  context.subscriptions.push(output);

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'rag.selectActiveProject';
  statusItem.text = '$(rocket) RAG: ...';
  statusItem.tooltip = 'Click to switch active RAG project';
  statusItem.show();
  context.subscriptions.push(statusItem);

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
      statusItem.text = `$(rocket) RAG: ${activeProjectName() ?? activeProjectId.slice(0, 8)}`;
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
      if (!activeProjectId) {
        void vscode.window.showWarningMessage('Pick an active project first.');
        return;
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
        const r = await api.createTask({ task, mode: mode ?? 'balanced', project: activeProjectId });
        void vscode.window.showInformationMessage(`Task ${r.task_id.slice(0, 8)} queued`);
        tasksView.refresh();
        // Auto-stream so the user sees progress immediately
        void streamToOutput(api, output, r.task_id);
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
        void streamToOutput(api, output, r.index_id);
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
      void streamToOutput(api, output, id);
    }),
  );
}

export function deactivate(): void {
  // OutputChannel and other disposables registered via context.subscriptions
  // are torn down by VSCode automatically.
}

async function streamToOutput(api: RagApiClient, output: vscode.OutputChannel, id: string): Promise<void> {
  output.show(true);
  output.appendLine(`\n── streaming ${id} ──`);
  try {
    for await (const event of api.streamTask(id)) {
      output.appendLine(formatEventLine(event));
    }
    output.appendLine(`── stream ${id} closed ──`);
  } catch (err) {
    output.appendLine(`stream error: ${String(err)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
