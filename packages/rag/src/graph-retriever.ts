import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { glob } from 'glob';
import { config, logger, taskEvents } from '@rag-system/shared';
import { createEmbedBackend, effectiveEmbedModel } from '@rag-system/model-router';
import type { ModelBackend } from '@rag-system/model-router';
import { ASTParser, CodeGraph } from '@rag-system/code-graph';
import { VectorStore } from './vector-store.js';

/**
 * v1.32-d — nomic-embed-text-v1.5 was trained with task-specific prefixes.
 * Without them, similarity scores degrade by ~5-10%. The prefix is a property
 * of the MODEL, not the backend, so we wire it here at the rag-system call
 * sites — both Ollama and llama-swap paths benefit transparently.
 *
 * - `search_query: <text>` for retrieval-time embedding (the user's query)
 * - `search_document: <text>` for index-time embedding (the corpus symbols)
 *
 * Cache keys factor in the mode so the same raw text embedded as a query and
 * as a document don't collide — they're SEMANTICALLY different vectors.
 */
type EmbedMode = 'query' | 'document';

const EMBED_PREFIX: Record<EmbedMode, string> = {
  query: 'search_query: ',
  document: 'search_document: ',
};

export interface ContextItem {
  symbolName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
}

interface RetrieverStore {
  getFileHash(filePath: string): string | undefined;
  saveFileHash(filePath: string, hash: string): void;
  deleteFileHash(filePath: string): void;
  getCachedEmbedding(cacheKey: string): number[] | undefined;
  saveCachedEmbedding(cacheKey: string, vector: number[]): void;
}

export class GraphRetriever {
  private vectorStore: VectorStore;
  private codeGraph: CodeGraph;
  private embedClient: ModelBackend;
  private embedModelLabel: string;
  private parser: ASTParser;
  private store: RetrieverStore | null = null;
  // Global semaphore — caps concurrent embed network calls (Ollama or
  // llama-swap, depending on backend) across all in-flight files & symbols.
  // Cache hits don't acquire it.
  private embedSemaphore: Semaphore;

  constructor(store?: RetrieverStore, paths?: { vectorsDir?: string; graphsDir?: string }) {
    this.vectorStore = new VectorStore(paths?.vectorsDir);
    this.codeGraph = new CodeGraph(paths?.graphsDir);
    this.embedClient = createEmbedBackend();
    this.embedModelLabel = effectiveEmbedModel();
    this.parser = new ASTParser();
    this.store = store ?? null;
    this.embedSemaphore = new Semaphore(config.rag.embedConcurrency);
  }

  private async embedWithCache(text: string, mode: EmbedMode): Promise<number[]> {
    const prefixed = EMBED_PREFIX[mode] + text;
    if (!this.store) {
      return this.embedSemaphore.run(() => this.embedClient.embed(prefixed));
    }
    // Cache key includes both the model label and the mode so query/doc
    // embeddings of identical text don't collide, and an Ollama-built cache
    // doesn't get reused after switching to llama-swap.
    const key = crypto.createHash('sha1')
      .update(`${this.embedModelLabel}:${mode}:${text}`)
      .digest('hex');
    const cached = this.store.getCachedEmbedding(key);
    if (cached) return cached;
    const vector = await this.embedSemaphore.run(() => this.embedClient.embed(prefixed));
    this.store.saveCachedEmbedding(key, vector);
    return vector;
  }

  /**
   * Live reference to the in-memory CodeGraph. Exposed so callers can build a
   * repo-map (or any other graph-derived view) without a separate snapshot or
   * disk re-read. Treat as read-only — the retriever owns mutations.
   */
  get graph(): CodeGraph {
    return this.codeGraph;
  }

  async retrieveContext(query: string): Promise<string> {
    const items = await this.retrieveContextItems(query, 5);
    if (items.length === 0) return '';
    return items.map(item => `// ${item.filePath}:${item.startLine}\n${item.text}`).join('\n\n---\n\n');
  }

  async retrieveContextItems(query: string, k = 5): Promise<ContextItem[]> {
    if (this.vectorStore.size === 0) return [];

    let queryVector: number[];
    try {
      queryVector = await this.embedWithCache(query, 'query');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug({ error: msg }, 'Embedding unavailable, skipping RAG context');
      return [];
    }

    const results = await this.vectorStore.search(queryVector, k);
    if (results.length === 0) return [];

    const items: ContextItem[] = [];
    let tokenEstimate = 0;
    const maxTokens = config.rag.maxContextTokens;

    for (const result of results) {
      const symbol = this.codeGraph.getSymbol(result.id);
      if (!symbol) continue;

      const snippetTokens = Math.ceil(symbol.text.length / 4);
      if (tokenEstimate + snippetTokens > maxTokens) break;

      items.push({
        symbolName: symbol.name,
        filePath: symbol.filePath,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        text: symbol.text,
      });
      tokenEstimate += snippetTokens;

      const deps = this.codeGraph.getDependencies(result.id);
      for (const dep of deps.slice(0, 2)) {
        const depTokens = Math.ceil(dep.text.length / 4);
        if (tokenEstimate + depTokens > maxTokens) break;
        items.push({
          symbolName: dep.name,
          filePath: dep.filePath,
          startLine: dep.startLine,
          endLine: dep.endLine,
          text: dep.text,
        });
        tokenEstimate += depTokens;
      }
    }

    logger.debug({ symbols: items.length, tokenEstimate }, 'RAG context retrieved');
    return items;
  }

  async indexFile(filePath: string): Promise<void> {
    // Drop stale vectors for any symbols this file used to define
    const previous = this.codeGraph.getByFile(filePath);
    for (const old of previous) {
      await this.vectorStore.removeById(old.name);
    }

    const symbols = this.parser.parseFile(filePath);
    if (symbols.length === 0) {
      this.codeGraph.removeFile(filePath);
      return;
    }

    this.codeGraph.addFile(filePath, symbols);

    // Embed all symbols in parallel — the global embedSemaphore inside embedWithCache
    // throttles real Ollama traffic, and VectorStore.add() is mutex-protected so
    // concurrent inserts serialize inside the index.
    await Promise.all(symbols.map(async (symbol) => {
      const text = `${symbol.kind} ${symbol.name}: ${symbol.text}`;
      try {
        const vector = await this.embedWithCache(text, 'document');
        await this.vectorStore.add(symbol.name, vector, { filePath, kind: symbol.kind });
      } catch {
        // Embed backend unavailable — skip vector, code graph still populated
      }
    }));
  }

  async removeFile(filePath: string): Promise<void> {
    const symbols = this.codeGraph.getByFile(filePath);
    for (const sym of symbols) {
      await this.vectorStore.removeById(sym.name);
    }
    this.codeGraph.removeFile(filePath);
    if (this.store) this.store.deleteFileHash(filePath);
    logger.debug({ filePath, removed: symbols.length }, 'File removed from index');
  }

  async flush(): Promise<void> {
    await this.vectorStore.save();
    await this.codeGraph.saveToDisk();
  }

  async indexCodebase(rootDir: string, opts: { indexId?: string } = {}): Promise<string> {
    const indexId = opts.indexId ?? `idx-${Date.now()}`;
    const absRoot = path.resolve(rootDir);
    const ignore = config.codeGraph.exclude.map(e => `**/${e}/**`);

    const files: string[] = [];
    for (const pattern of config.codeGraph.include) {
      const found = await glob(pattern, { cwd: absRoot, ignore, absolute: true });
      files.push(...found);
    }

    // Prune graph entries for files that no longer exist on disk. The glob
    // above is the ground truth for "what is currently here"; anything in the
    // graph but missing from the discovered set was deleted out-of-band (e.g.
    // `git reset --hard`, manual `rm`). Without this step, repo-map and RAG
    // keep advertising symbols from vanished files — agents then reference
    // ghost methods/files and patches fail with "search not found".
    const discovered = new Set(files);
    const knownPaths = new Set(this.codeGraph.getAll().map(s => s.filePath));
    let pruned = 0;
    for (const known of knownPaths) {
      if (!discovered.has(known)) {
        await this.removeFile(known);
        pruned++;
      }
    }
    if (pruned > 0) {
      logger.info({ indexId, pruned }, 'Pruned vanished files from index');
    }

    let indexed = 0;
    let skipped = 0;
    let processed = 0;
    const startedAt = Date.now();
    let lastTickAt = 0;

    logger.info(
      { indexId, files: files.length, root: absRoot, fileConcurrency: config.rag.fileConcurrency },
      'Indexing codebase',
    );

    taskEvents.emitEvent({
      taskId: indexId,
      type: 'index_start',
      message: `Indexing ${files.length} file(s)`,
      data: { root: absRoot, totalFiles: files.length },
    });

    // Throttle per-file events so a 1000-file repo doesn't fire 1000 events.
    // We always emit on the very last file so SSE clients see 100% complete.
    const TICK_MS = 200;
    const tickIfDue = (eventType: 'index_file' | 'index_skip', file: string) => {
      processed++;
      const now = Date.now();
      const isLast = processed === files.length;
      if (!isLast && now - lastTickAt < TICK_MS) return;
      lastTickAt = now;
      taskEvents.emitEvent({
        taskId: indexId,
        type: eventType,
        data: {
          file,
          processed,
          totalFiles: files.length,
          indexed,
          skipped,
          percent: Math.round((processed / Math.max(1, files.length)) * 100),
        },
      });
    };

    // File-level pMap controls how many files we parse + queue embeddings for at once.
    // Per-file embed traffic is independently capped by the global embedSemaphore, so
    // total concurrent Ollama calls never exceed `embedConcurrency` regardless of how
    // many files are in flight.
    await pMap(files, config.rag.fileConcurrency, async (file) => {
      if (this.store) {
        let currentHash: string;
        try {
          currentHash = crypto.createHash('sha1').update(await fs.promises.readFile(file)).digest('hex');
        } catch {
          return;
        }
        if (this.store.getFileHash(file) === currentHash) {
          skipped++;
          tickIfDue('index_skip', file);
          return;
        }
        await this.indexFile(file);
        this.store.saveFileHash(file, currentHash);
        indexed++;
        tickIfDue('index_file', file);
      } else {
        await this.indexFile(file);
        indexed++;
        tickIfDue('index_file', file);
      }
    });

    await this.vectorStore.save();
    await this.codeGraph.saveToDisk();

    const durationMs = Date.now() - startedAt;
    logger.info({ indexId, indexed, skipped, pruned, vectors: this.vectorStore.size, durationMs }, 'Codebase indexed');

    taskEvents.emitEvent({
      taskId: indexId,
      type: 'index_done',
      message: `Indexed ${indexed} file(s), skipped ${skipped}${pruned > 0 ? `, pruned ${pruned}` : ''}`,
      data: { indexed, skipped, pruned, totalFiles: files.length, vectors: this.vectorStore.size, durationMs },
    });

    return indexId;
  }

  async loadFromDisk(): Promise<void> {
    const results = await Promise.allSettled([
      this.vectorStore.loadFromDisk(),
      this.codeGraph.loadFromDisk(),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') {
        logger.warn({ error: r.reason }, 'RAG component load failed, starting fresh');
      }
    }
  }
}

/**
 * Bounded-concurrency map: keeps up to `n` worker promises in flight, picking the
 * next item from a shared cursor as each finishes. ~Optimal utilization vs. fixed
 * batches for heterogeneous latencies.
 */
async function pMap<T>(items: T[], n: number, mapper: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(n, items.length));
  let cursor = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      await mapper(items[i]);
    }
  });
  await Promise.all(workers);
}

/**
 * Counting semaphore — caps how many `run()` callbacks may be executing at once.
 * Acquirers beyond the cap queue and resume FIFO as slots free.
 */
class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this.available = Math.max(1, capacity);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.available > 0) {
      this.available--;
    } else {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.available++;
    }
  }
}
