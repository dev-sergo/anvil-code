import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { glob } from 'glob';
import { config, logger, taskEvents } from '@rag-system/shared';
import { createEmbedBackend, effectiveEmbedModel } from '@rag-system/model-router';
import type { ModelBackend } from '@rag-system/model-router';
import { ASTParser, CodeGraph } from '@rag-system/code-graph';
import { VectorStore } from './vector-store.js';
import { BM25Index } from './bm25.js';

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
  private bm25Index: BM25Index;
  private embedClient: ModelBackend;
  private embedModelLabel: string;
  private parser: ASTParser;
  private store: RetrieverStore | null = null;
  private graphsDir: string;
  // v1.42 — monorepo meta: tsconfig.json paths + package.json exports,
  // parsed at index time and injected as a pinned ContextItem so LLM
  // always knows the correct import aliases for workspace packages.
  private monorepoMeta: string | null = null;
  // Global semaphore — caps concurrent embed network calls (Ollama or
  // llama-swap, depending on backend) across all in-flight files & symbols.
  // Cache hits don't acquire it.
  private embedSemaphore: Semaphore;

  constructor(store?: RetrieverStore, paths?: { vectorsDir?: string; graphsDir?: string }) {
    this.graphsDir = path.resolve(paths?.graphsDir ?? config.rag.graphsPath);
    this.vectorStore = new VectorStore(paths?.vectorsDir);
    this.codeGraph = new CodeGraph(paths?.graphsDir);
    this.bm25Index = new BM25Index();
    this.embedClient = createEmbedBackend();
    this.embedModelLabel = effectiveEmbedModel();
    this.parser = new ASTParser();
    this.store = store ?? null;
    this.embedSemaphore = new Semaphore(config.rag.embedConcurrency);
    this.loadMonorepoMeta();
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

  // v1.42 — load persisted monorepo meta from disk (written by indexMonorepoMeta).
  private loadMonorepoMeta(): void {
    const metaPath = path.join(this.graphsDir, 'monorepo-meta.json');
    if (!fs.existsSync(metaPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { text: string };
      this.monorepoMeta = raw.text ?? null;
      if (this.monorepoMeta) {
        logger.debug({ lines: this.monorepoMeta.split('\n').length }, 'Monorepo meta loaded from disk');
      }
    } catch {
      // Corrupt file — ignore; will be rewritten at next indexCodebase.
    }
  }

  // v1.42 — parse tsconfig.json `compilerOptions.paths` and each workspace
  // package's `package.json#exports` into a single human-readable text block.
  // Called during indexCodebase so the data is always fresh. Persists to
  // `graphsDir/monorepo-meta.json` for reload across API restarts.
  private async indexMonorepoMeta(rootDir: string): Promise<void> {
    const lines: string[] = [];

    // 1. tsconfig.json paths aliases
    const tsconfigCandidates = ['tsconfig.json', 'tsconfig.base.json'];
    for (const candidate of tsconfigCandidates) {
      const tsconfigPath = path.join(rootDir, candidate);
      if (!fs.existsSync(tsconfigPath)) continue;
      try {
        const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8')) as {
          compilerOptions?: { paths?: Record<string, string[]> };
          extends?: string;
        };
        const paths = tsconfig.compilerOptions?.paths;
        if (paths && Object.keys(paths).length > 0) {
          lines.push('TypeScript module aliases — use these import paths, never raw relative paths across packages:');
          for (const [alias, targets] of Object.entries(paths)) {
            if (!Array.isArray(targets) || targets.length === 0) continue;
            // Skip wildcard duplicates if non-wildcard already listed
            const base = alias.replace('/*', '');
            if (alias.endsWith('/*') && lines.some(l => l.includes(`  ${base} →`))) continue;
            lines.push(`  ${alias} → ${(targets as string[])[0]}`);
          }
        }
      } catch { /* malformed JSON — skip */ }
      break; // first found wins
    }

    // 2. Per-package exports (walk packages/* looking for package.json)
    const packagesDir = path.join(rootDir, 'packages');
    if (fs.existsSync(packagesDir)) {
      const pkgDirs = fs.readdirSync(packagesDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      const exportLines: string[] = [];
      for (const pkgDir of pkgDirs) {
        const pkgJsonPath = path.join(packagesDir, pkgDir, 'package.json');
        if (!fs.existsSync(pkgJsonPath)) continue;
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
            name?: string;
            exports?: Record<string, unknown>;
          };
          const name = pkg.name;
          const exports = pkg.exports;
          if (!name || !exports) continue;
          const paths = Object.keys(exports).filter(k => k !== './package.json').slice(0, 8);
          if (paths.length > 0) {
            exportLines.push(`  ${name}: ${paths.join(', ')}`);
          }
        } catch { /* skip */ }
      }
      if (exportLines.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('Package sub-path exports (valid import specifiers):');
        lines.push(...exportLines);
      }
    }

    if (lines.length === 0) {
      this.monorepoMeta = null;
      return;
    }

    this.monorepoMeta = lines.join('\n');
    fs.mkdirSync(this.graphsDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.graphsDir, 'monorepo-meta.json'),
      JSON.stringify({ text: this.monorepoMeta, updatedAt: new Date().toISOString() }),
      'utf8',
    );
    logger.info({ rootDir, lines: lines.length }, 'Monorepo meta indexed and saved');
  }

  async retrieveContext(query: string): Promise<string> {
    const items = await this.retrieveContextItems(query, 5);
    if (items.length === 0) return '';
    return items.map(item => `// ${item.filePath}:${item.startLine}\n${item.text}`).join('\n\n---\n\n');
  }

  async retrieveContextItems(query: string, k = 5): Promise<ContextItem[]> {
    // v1.42 — monorepo meta is always injected regardless of vector index size.
    // v1.42: return early only when BOTH index is empty AND no meta is available.
    if (this.vectorStore.size === 0 && !this.monorepoMeta) return [];

    const items: ContextItem[] = [];
    let tokenEstimate = 0;
    const maxTokens = config.rag.maxContextTokens;

    // Vector + BM25 + reranker retrieval — skipped when index is empty.
    if (this.vectorStore.size > 0) {
      let queryVector: number[];
      try {
        queryVector = await this.embedWithCache(query, 'query');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.debug({ error: msg }, 'Embedding unavailable, skipping RAG context');
        queryVector = [];
      }

      if (queryVector.length > 0) {
        const useReranker = config.rag.rerankerEnabled && typeof this.embedClient.rerank === 'function';
        const useBM25 = config.rag.bm25Enabled && this.bm25Index.size > 0;
        const candidateCount = useReranker ? config.rag.rerankerCandidates : k;

        let candidates = await this.vectorStore.search(queryVector, candidateCount);

        if (useBM25) {
          const bm25Results = this.bm25Index.search(query, config.rag.bm25Candidates);
          const mergedIds = BM25Index.rrf(
            candidates.map(c => c.id),
            bm25Results.map(r => r.id),
          );
          const denseById = new Map(candidates.map(c => [c.id, c]));
          candidates = mergedIds.map(id => denseById.get(id) ?? { id, distance: 0 });
          logger.debug(
            { dense: candidates.length, bm25: bm25Results.length, merged: mergedIds.length },
            'RAG BM25 hybrid merge applied',
          );
        }

        let results = candidates;
        if (useReranker) {
          const symbols = candidates.map(c => this.codeGraph.getSymbol(c.id));
          const docs = symbols.map(s => s ? `${s.kind} ${s.name}: ${s.text}`.slice(0, 400) : '');
          try {
            const ranked = await this.embedClient.rerank!(query, docs);
            results = ranked.slice(0, k).map(r => candidates[r.index]);
            logger.debug({ candidates: candidates.length, reranked: results.length }, 'RAG reranker applied');
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn({ error: msg }, 'Reranker failed, falling back to HNSW order');
            results = candidates.slice(0, k);
          }
        }

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
      }
    }

    // v1.42 — always append monorepo meta (tsconfig paths + package exports)
    // as a pinned item so LLM knows the correct import aliases for workspace
    // packages. Placed last so it never displaces primary symbol context.
    if (this.monorepoMeta) {
      const metaTokens = Math.ceil(this.monorepoMeta.length / 4);
      if (tokenEstimate + metaTokens <= maxTokens) {
        items.push({
          symbolName: '__monorepo_imports__',
          filePath: 'tsconfig.json',
          startLine: 1,
          endLine: 1,
          text: this.monorepoMeta,
        });
      }
    }

    logger.debug({ symbols: items.length, tokenEstimate }, 'RAG context retrieved');
    return items;
  }

  async indexFile(filePath: string): Promise<void> {
    // Drop stale vectors and BM25 entries for any symbols this file used to define
    const previous = this.codeGraph.getByFile(filePath);
    for (const old of previous) {
      await this.vectorStore.removeById(old.name);
      this.bm25Index.remove(old.name);
    }

    const symbols = this.parser.parseFile(filePath);
    if (symbols.length === 0) {
      this.codeGraph.removeFile(filePath);
      return;
    }

    this.codeGraph.addFile(filePath, symbols);

    await Promise.all(symbols.map(async (symbol) => {
      // BM25 corpus: path components + symbol name ×3 (boost exact-name matches)
      // + kind + body text. Tokenizer lowercases and splits on non-word chars.
      const pathTokens = filePath.split('/').flatMap(p => p.split('.'));
      const bm25Corpus = [
        ...pathTokens,
        symbol.name, symbol.name, symbol.name,
        symbol.kind,
        symbol.text,
      ].join(' ');
      this.bm25Index.add(symbol.name, bm25Corpus);

      const embedText = `${symbol.kind} ${symbol.name}: ${symbol.text}`;
      try {
        const vector = await this.embedWithCache(embedText, 'document');
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
      this.bm25Index.remove(sym.name);
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
    // Exclude standard dirs + the backups dir (relative path from project root).
    // Backup files are TypeScript but are noise in retrieval — they match every
    // query because they contain fragments of every file ever edited.
    const backupsRel = path.relative(absRoot, path.resolve(rootDir, config.safeExec.backupsPath));
    const ignore = [
      ...config.codeGraph.exclude.map(e => `**/${e}/**`),
      `${backupsRel}/**`,
    ];

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
    // v1.42 — parse and persist monorepo meta (tsconfig paths + package exports)
    // so the next retrieveContextItems call can inject it as a pinned item.
    await this.indexMonorepoMeta(absRoot);

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
    // Rebuild BM25 index from the in-memory CodeGraph (no separate persistence).
    // CodeGraph is the source of truth for symbol bodies; BM25 is derived.
    this.bm25Index = new BM25Index();
    for (const symbol of this.codeGraph.getAll()) {
      const pathTokens = symbol.filePath.split('/').flatMap(p => p.split('.'));
      const corpus = [
        ...pathTokens,
        symbol.name, symbol.name, symbol.name,
        symbol.kind,
        symbol.text,
      ].join(' ');
      this.bm25Index.add(symbol.name, corpus);
    }
    if (this.bm25Index.size > 0) {
      logger.debug({ symbols: this.bm25Index.size }, 'BM25 index rebuilt from CodeGraph');
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
