import * as vscode from 'vscode';
import type { RagApiClient, TaskRecord } from './api-client.js';
import { taskLabel, taskStatusIcon, taskTooltip } from './format.js';

class TaskItem extends vscode.TreeItem {
  constructor(public readonly task: TaskRecord) {
    super(taskLabel(task), vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'task';
    this.description = `${task.status} · ${task.id.slice(0, 8)}`;
    this.tooltip = new vscode.MarkdownString(taskTooltip(task));
    this.iconPath = new vscode.ThemeIcon(taskStatusIcon(task.status));
    this.command = {
      command: 'rag.streamTask',
      title: 'Stream Progress',
      arguments: [task.id],
    };
  }
}

class EmptyHintItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

export class TasksView implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private cache: TaskRecord[] = [];

  constructor(
    private api: RagApiClient,
    private getActiveProjectId: () => string | undefined,
  ) {}

  refresh(): void {
    void this.reload().then(() => this._onDidChange.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const projectId = this.getActiveProjectId();
    if (!projectId) return [new EmptyHintItem('Select a project to see its tasks')];
    if (this.cache.length === 0) await this.reload();
    if (this.cache.length === 0) return [new EmptyHintItem('No tasks yet — try RAG: Run Task')];
    return this.cache.map(t => new TaskItem(t));
  }

  private async reload(): Promise<void> {
    const projectId = this.getActiveProjectId();
    if (!projectId) {
      this.cache = [];
      return;
    }
    try {
      this.cache = await this.api.listTasks(projectId);
    } catch (err) {
      void vscode.window.showErrorMessage(`RAG: failed to load tasks — ${String(err)}`);
      this.cache = [];
    }
  }
}
