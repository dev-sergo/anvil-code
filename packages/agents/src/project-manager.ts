import { logger } from '@rag-system/shared';
import { MemoryStore, ProjectRegistry, projectPaths } from '@rag-system/memory';
import type { Project } from '@rag-system/memory';
import { GraphRetriever } from '@rag-system/rag';
import { SafeWriter, BackupManager } from '@rag-system/safe-exec';
import { GitEngine } from '@rag-system/git-engine';
import { ModelRouter } from '@rag-system/model-router';
import { Orchestrator } from './orchestrator.js';

export interface ProjectContext {
  project: Project;
  store: MemoryStore;
  retriever: GraphRetriever;
  writer: SafeWriter;
  backups: BackupManager;
  git: GitEngine;
  orchestrator: Orchestrator;
}

/**
 * Per-project component lifecycle manager. Lazily creates a `ProjectContext`
 * (MemoryStore, VectorStore via GraphRetriever, SafeWriter, GitEngine, Orchestrator)
 * scoped to that project's data directory, and reuses it across requests.
 *
 * The router is shared across all projects since it's a thin client over Ollama.
 */
export class ProjectManager {
  private contexts = new Map<string, ProjectContext>();

  constructor(
    private registry: ProjectRegistry,
    private router: ModelRouter,
  ) {}

  /** Lookup or instantiate a context for the given project id. */
  async get(projectId: string): Promise<ProjectContext> {
    const cached = this.contexts.get(projectId);
    if (cached) {
      this.registry.touch(projectId);
      return cached;
    }

    const project = this.registry.get(projectId);
    if (!project) throw new Error(`Project ${projectId} not registered`);

    const ctx = await this.create(project);
    this.contexts.set(projectId, ctx);
    this.registry.touch(projectId);
    return ctx;
  }

  /** All currently-loaded contexts (does not load on-disk projects that haven't been touched). */
  loaded(): ProjectContext[] {
    return [...this.contexts.values()];
  }

  /** Tear down one project's resources without removing it from the registry. */
  closeContext(projectId: string): void {
    const ctx = this.contexts.get(projectId);
    if (!ctx) return;
    try { ctx.store.close(); } catch { /* ignore */ }
    this.contexts.delete(projectId);
    logger.debug({ projectId }, 'Project context closed');
  }

  /** Tear down every loaded context. Safe to call on shutdown. */
  closeAll(): void {
    for (const id of [...this.contexts.keys()]) this.closeContext(id);
  }

  private async create(project: Project): Promise<ProjectContext> {
    const paths = projectPaths(project);
    logger.info({ projectId: project.id, root: project.root, paths: paths.base }, 'Loading project context');

    const store = new MemoryStore(paths.memoryDb);
    const retriever = new GraphRetriever(store, {
      vectorsDir: paths.vectorsDir,
      graphsDir: paths.graphsDir,
    });
    await retriever.loadFromDisk();

    const writer = new SafeWriter(project.root);
    const backups = new BackupManager(paths.backupsDir);
    const git = new GitEngine(project.root);
    const orchestrator = new Orchestrator(this.router, retriever, writer, store, git);

    return { project, store, retriever, writer, backups, git, orchestrator };
  }
}
