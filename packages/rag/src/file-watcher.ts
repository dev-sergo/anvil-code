import path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import { config, logger } from '@rag-system/shared';
import type { GraphRetriever } from './graph-retriever.js';

type PendingAction = 'reindex' | 'remove';

export interface FileWatcherOptions {
  debounceMs?: number;
  rootDir?: string;
}

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private pending = new Map<string, PendingAction>();
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private readonly debounceMs: number;
  private readonly rootDir: string;

  constructor(private retriever: GraphRetriever, opts: FileWatcherOptions = {}) {
    this.debounceMs = opts.debounceMs ?? config.watcher.debounceMs;
    this.rootDir = path.resolve(opts.rootDir ?? config.projectRoot);
  }

  start(): void {
    if (this.watcher) return;

    const include = config.codeGraph.include.map(p => path.join(this.rootDir, p));
    const ignored = [
      ...config.codeGraph.exclude.map(e => `**/${e}/**`),
      '**/.*/**',
      '**/dist/**',
      '**/node_modules/**',
    ];

    this.watcher = chokidar.watch(include, {
      ignored,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    this.watcher
      .on('add', p => this.enqueue(p, 'reindex'))
      .on('change', p => this.enqueue(p, 'reindex'))
      .on('unlink', p => this.enqueue(p, 'remove'))
      .on('error', err => logger.warn({ error: String(err) }, 'FileWatcher error'));

    logger.info({ rootDir: this.rootDir, debounceMs: this.debounceMs }, 'FileWatcher started');
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    // Drain anything that was queued
    await this.flushing;
    if (this.pending.size > 0) await this.flush();
    logger.info('FileWatcher stopped');
  }

  /** Test/forced flush — wait for any in-flight + drain pending queue. */
  async drain(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushing;
    if (this.pending.size > 0) await this.flush();
  }

  private enqueue(filePath: string, action: PendingAction): void {
    const abs = path.resolve(filePath);
    // Latest action wins (unlink overrides earlier reindex; reindex after delete brings it back)
    this.pending.set(abs, action);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushing = this.flush().catch(err => {
        logger.error({ error: String(err) }, 'FileWatcher flush failed');
      });
    }, this.debounceMs);
  }

  private async flush(): Promise<void> {
    const batch = [...this.pending.entries()];
    this.pending.clear();
    if (batch.length === 0) return;

    let reindexed = 0;
    let removed = 0;

    for (const [filePath, action] of batch) {
      try {
        if (action === 'remove') {
          await this.retriever.removeFile(filePath);
          removed++;
        } else {
          await this.retriever.indexFile(filePath);
          reindexed++;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ filePath, action, error: msg }, 'FileWatcher entry failed');
      }
    }

    try {
      await this.retriever.flush();
    } catch (err: unknown) {
      logger.warn({ error: String(err) }, 'FileWatcher flush-to-disk failed');
    }

    logger.info({ reindexed, removed }, 'FileWatcher batch processed');
  }
}
