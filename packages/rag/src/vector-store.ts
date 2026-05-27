import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { config, logger } from '@rag-system/shared';
import type { HierarchicalNSW as HNSWType } from 'hnswlib-node';

const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const hnswlib = _require('hnswlib-node') as {
  HierarchicalNSW: new (space: string, dim: number) => HNSWType;
};

export interface VectorSearchResult {
  id: string;
  distance: number;
  metadata?: Record<string, unknown>;
}

interface LabelMapData {
  labelToId: Record<string, string>;
  idToLabel: Record<string, number>;
  nextLabel: number;
}

export class VectorStore {
  private index: HNSWType;
  private labelToId: Map<number, string> = new Map();
  private idToLabel: Map<string, number> = new Map();
  private metadata: Map<string, Record<string, unknown>> = new Map();
  private nextLabel = 0;
  private dim: number;
  private maxElements: number;
  private vectorsDir: string;

  // Promise-chain mutex — prevents concurrent add/save from corrupting labels
  private _writeLock: Promise<void> = Promise.resolve();

  constructor(vectorsDir?: string) {
    this.dim = config.rag.embeddingDim;
    this.maxElements = config.rag.maxElements;
    this.vectorsDir = path.resolve(vectorsDir ?? config.rag.vectorsPath);
    this.index = new hnswlib.HierarchicalNSW('cosine', this.dim);
    this.index.initIndex(this.maxElements);
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this._writeLock.then(fn, fn);
    // swallow result for the lock chain so it stays resolved
    this._writeLock = next.then(() => undefined, () => undefined);
    return next;
  }

  async add(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void> {
    return this.withLock(async () => {
      if (this.idToLabel.has(id)) return;

      if (this.nextLabel >= this.maxElements) {
        this.maxElements = Math.ceil(this.maxElements * 1.5);
        this.index.resizeIndex(this.maxElements);
        logger.debug({ newMax: this.maxElements }, 'VectorStore resized');
      }

      const label = this.nextLabel++;
      this.index.addPoint(vector, label);
      this.idToLabel.set(id, label);
      this.labelToId.set(label, id);
      if (metadata) this.metadata.set(id, metadata);
    });
  }

  async removeById(id: string): Promise<void> {
    return this.withLock(async () => {
      const label = this.idToLabel.get(id);
      if (label === undefined) return;
      try {
        this.index.markDelete(label);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.debug({ id, label, error: msg }, 'markDelete failed (ignored)');
      }
      this.idToLabel.delete(id);
      this.labelToId.delete(label);
      this.metadata.delete(id);
    });
  }

  // filter is accepted for interface compatibility with QdrantVectorStore but
  // ignored — HNSW performs a global ANN search without payload filtering.
  async search(vector: number[], k: number, _filter?: { filePath?: string; packageName?: string }): Promise<VectorSearchResult[]> {
    const count = this.nextLabel;
    if (count === 0) return [];

    const actualK = Math.min(k, count);
    const result = this.index.searchKnn(vector, actualK);

    return result.neighbors.map((label, i) => ({
      id: this.labelToId.get(label) ?? String(label),
      distance: result.distances[i] ?? 1,
      metadata: this.metadata.get(this.labelToId.get(label) ?? '') ?? undefined,
    }));
  }

  async save(): Promise<void> {
    return this.withLock(async () => {
      fs.mkdirSync(this.vectorsDir, { recursive: true });
      const indexPath = path.join(this.vectorsDir, 'index.hnsw');
      const labelsPath = path.join(this.vectorsDir, 'labels.json');

      const data: LabelMapData = {
        labelToId: Object.fromEntries([...this.labelToId.entries()].map(([k, v]) => [String(k), v])),
        idToLabel: Object.fromEntries(this.idToLabel),
        nextLabel: this.nextLabel,
      };

      // Atomic write: write to .tmp first, then rename (POSIX rename is atomic)
      this.index.writeIndexSync(indexPath + '.tmp');
      await fs.promises.writeFile(labelsPath + '.tmp', JSON.stringify(data), 'utf8');
      fs.renameSync(indexPath + '.tmp', indexPath);
      fs.renameSync(labelsPath + '.tmp', labelsPath);

      logger.debug({ vectors: this.nextLabel }, 'VectorStore saved');
    });
  }

  async loadFromDisk(): Promise<void> {
    const indexPath = path.join(this.vectorsDir, 'index.hnsw');
    const labelsPath = path.join(this.vectorsDir, 'labels.json');

    if (!fs.existsSync(indexPath) || !fs.existsSync(labelsPath)) return;

    try {
      this.index.readIndexSync(indexPath);
      const labelsData = JSON.parse(fs.readFileSync(labelsPath, 'utf8')) as LabelMapData;
      this.labelToId = new Map(
        Object.entries(labelsData.labelToId).map(([k, v]) => [Number(k), v])
      );
      this.idToLabel = new Map(
        Object.entries(labelsData.idToLabel).map(([k, v]) => [k, Number(v)])
      );
      this.nextLabel = labelsData.nextLabel;
      logger.info({ vectors: this.nextLabel }, 'VectorStore loaded from disk');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ error: msg }, 'Failed to load VectorStore, starting fresh');
      this.reset();
    }
  }

  get size(): number {
    return this.nextLabel;
  }

  private reset(): void {
    this.index = new hnswlib.HierarchicalNSW('cosine', this.dim);
    this.index.initIndex(this.maxElements);
    this.labelToId.clear();
    this.idToLabel.clear();
    this.metadata.clear();
    this.nextLabel = 0;
  }
}
