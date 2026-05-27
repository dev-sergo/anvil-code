/**
 * v1.47 — Qdrant-backed VectorStore. Implements the same interface as the
 * HNSW VectorStore so GraphRetriever needs no changes. Activated via
 * VECTOR_BACKEND=qdrant (QDRANT_URL=http://localhost:6333).
 *
 * Benefits over HNSW JSON:
 * - No 10K element cap (handled externally by Qdrant server)
 * - Persistent storage managed by Qdrant (no save()/loadFromDisk() overhead)
 * - payload.filePath stored for future scope-filtered retrieval
 *
 * Collection naming: derived from the vectorsDir path (last two path segments,
 * sanitised) so per-project isolation is automatic when DATA_ROOT is set.
 */
import path from 'path';
import crypto from 'crypto';
import { logger } from '@rag-system/shared';
import type { VectorSearchResult } from './vector-store.js';
import { QdrantClient } from '@qdrant/js-client-rest';

// Re-export so callers don't import vector-store.ts when only the type is needed.
export type { VectorSearchResult };

export class QdrantVectorStore {
  private client: QdrantClient;
  private collectionName: string;
  private dim: number;
  private _size = 0;
  private ready: Promise<void>;

  constructor(vectorsDir: string, qdrantUrl: string, dim: number) {
    this.client = new QdrantClient({ url: qdrantUrl });
    this.dim = dim;
    // Derive a stable collection name from the vectorsDir path.
    const parts = path.resolve(vectorsDir).split(path.sep).filter(Boolean);
    const slug = parts.slice(-2).join('_').replace(/[^a-zA-Z0-9_-]/g, '_');
    this.collectionName = `anvil_${slug}`;
    this.ready = this.ensureCollection();
  }

  private async ensureCollection(): Promise<void> {
    try {
      const collections = await this.client.getCollections();
      const exists = collections.collections.some(c => c.name === this.collectionName);
      if (!exists) {
        await this.client.createCollection(this.collectionName, {
          vectors: { size: this.dim, distance: 'Cosine' },
        });
        logger.info({ collection: this.collectionName }, 'Qdrant collection created');
      }
      const info = await this.client.getCollection(this.collectionName);
      this._size = info.points_count ?? 0;
      logger.info(
        { collection: this.collectionName, vectors: this._size },
        'Qdrant collection ready',
      );
    } catch (err: unknown) {
      logger.error({ error: String(err) }, 'Qdrant collection setup failed');
      throw err;
    }
  }

  async add(id: string, vector: number[], metadata?: Record<string, unknown>): Promise<void> {
    await this.ready;
    // Qdrant point id must be a UUID or unsigned int. Use a simple hash of id.
    const pointId = this.stringToUUID(id);
    try {
      await this.client.upsert(this.collectionName, {
        wait: true,
        points: [{
          id: pointId,
          vector,
          payload: { symbolName: id, ...(metadata ?? {}) },
        }],
      });
      this._size++;
    } catch (err: unknown) {
      logger.error({ id, pointId, error: String(err) }, 'Qdrant upsert failed');
    }
  }

  async removeById(id: string): Promise<void> {
    await this.ready;
    const pointId = this.stringToUUID(id);
    try {
      await this.client.delete(this.collectionName, { points: [pointId] });
      this._size = Math.max(0, this._size - 1);
    } catch (err: unknown) {
      logger.warn({ id, error: String(err) }, 'Qdrant delete failed');
    }
  }

  async search(
    vector: number[],
    k: number,
    filter?: { filePath?: string; packageName?: string },
  ): Promise<VectorSearchResult[]> {
    await this.ready;
    if (this._size === 0) return [];

    // v1.66 — prefer packageName exact match (reliable) over filePath exact match
    // (broken: stored payload has absolute path, filter has relative prefix).
    const qdrantFilter = filter?.packageName
      ? { must: [{ key: 'packageName', match: { value: filter.packageName } }] }
      : filter?.filePath
        ? { must: [{ key: 'filePath', match: { value: filter.filePath } }] }
        : undefined;

    try {
      const results = await this.client.search(this.collectionName, {
        vector,
        limit: k,
        with_payload: true,
        filter: qdrantFilter,
      });
      return results.map(r => ({
        id: String(r.payload?.symbolName ?? r.id),
        distance: 1 - (r.score ?? 0), // Qdrant cosine returns similarity, convert to distance
        metadata: r.payload as Record<string, unknown> | undefined,
      }));
    } catch (err: unknown) {
      logger.warn({ error: String(err) }, 'Qdrant search failed — returning empty');
      return [];
    }
  }

  // Qdrant handles persistence — these are no-ops.
  async save(): Promise<void> { /* Qdrant persists automatically */ }
  async loadFromDisk(): Promise<void> {
    await this.ready; // re-sync size from server
  }

  get size(): number {
    return this._size;
  }

  // Deterministic UUID v5-style: SHA-1 of the symbol name, formatted as UUID.
  // Qdrant requires a valid UUID (8-4-4-4-12 hex) or unsigned int as point id.
  private stringToUUID(s: string): string {
    const h = crypto.createHash('sha1').update(s).digest('hex');
    // Set version (4 in position 13) and variant (8/9/a/b in position 17).
    return [
      h.slice(0, 8),
      h.slice(8, 12),
      '4' + h.slice(13, 16),
      ((parseInt(h[16]!, 16) & 3) | 8).toString(16) + h.slice(17, 20),
      h.slice(20, 32),
    ].join('-');
  }
}
