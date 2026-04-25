import * as vscode from 'vscode';
import type { Project, RagApiClient } from './api-client.js';
import { projectLabel } from './format.js';

class ProjectItem extends vscode.TreeItem {
  constructor(public readonly project: Project, isActive: boolean) {
    super(projectLabel(project, isActive), vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'project';
    this.description = project.id.slice(0, 8);
    this.tooltip = new vscode.MarkdownString(
      [`**${project.name}**`, `ID: \`${project.id}\``, `Root: \`${project.root}\``].join('\n\n'),
    );
    this.iconPath = new vscode.ThemeIcon(isActive ? 'star-full' : 'folder');
    this.command = {
      command: 'rag.selectActiveProject',
      title: 'Set Active',
      arguments: [project.id],
    };
  }
}

export class ProjectsView implements vscode.TreeDataProvider<ProjectItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private cache: Project[] = [];

  constructor(
    private api: RagApiClient,
    private getActiveProjectId: () => string | undefined,
  ) {}

  refresh(): void {
    void this.reload().then(() => this._onDidChange.fire());
  }

  /** Synchronous accessor used by other commands without re-fetching. */
  current(): Project[] {
    return this.cache;
  }

  getTreeItem(element: ProjectItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<ProjectItem[]> {
    if (this.cache.length === 0) await this.reload();
    const active = this.getActiveProjectId();
    return this.cache.map(p => new ProjectItem(p, p.id === active));
  }

  private async reload(): Promise<void> {
    try {
      this.cache = await this.api.listProjects();
    } catch (err) {
      void vscode.window.showErrorMessage(`RAG: failed to load projects — ${String(err)}`);
      this.cache = [];
    }
  }
}
