import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';

vi.mock('@rag-system/shared', async () => {
  const actual = await vi.importActual<typeof import('@rag-system/shared')>('@rag-system/shared');
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    config: {
      ...actual.config,
      rag: { ...actual.config.rag, embedConcurrency: 4, maxContextTokens: 8000 },
    },
  };
});

vi.mock('hnswlib-node', async () => {
  const { writeFileSync } = await import('fs');
  return {
    HierarchicalNSW: class {
      initIndex(): void {}
      resizeIndex(): void {}
      addPoint(): void {}
      // Return a single match so the search path actually exercises the embed call.
      searchKnn(): { neighbors: number[]; distances: number[] } {
        return { neighbors: [0], distances: [0.1] };
      }
      writeIndexSync(p: string): void { writeFileSync(p, ''); }
      readIndexSync(): void {}
      markDelete(): void {}
      getCurrentCount(): number { return 1; }
    },
  };
});

const { GraphRetriever } = await import('../graph-retriever.js');
const { OllamaClient } = await import('@rag-system/model-router');

describe('GraphRetriever — nomic-embed-text-v1.5 task prefixes (v1.32-d)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-prefix-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('prepends "search_document: " when indexing symbols', async () => {
    const file = path.join(tmpDir, 'svc.ts');
    fs.writeFileSync(file, `export function userCreate() { return 1; }`);

    const seen: string[] = [];
    vi.spyOn(OllamaClient.prototype, 'embed').mockImplementation(async (text: string) => {
      seen.push(text);
      return new Array(768).fill(0);
    });

    const r = new GraphRetriever();
    await r.indexFile(file);

    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.startsWith('search_document: ')).toBe(true);
    }
  });

  it('prepends "search_query: " when retrieving context', async () => {
    const file = path.join(tmpDir, 'svc.ts');
    fs.writeFileSync(file, `export function userCreate() { return 1; }`);

    const seen: string[] = [];
    vi.spyOn(OllamaClient.prototype, 'embed').mockImplementation(async (text: string) => {
      seen.push(text);
      return new Array(768).fill(0);
    });

    const r = new GraphRetriever();
    await r.indexFile(file);

    seen.length = 0; // ignore index-time embeds; only inspect retrieval
    await r.retrieveContextItems('how do users get created?');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe('search_query: how do users get created?');
  });

  it('cache key separates query vs document modes for identical raw text', async () => {
    const cache = new Map<string, number[]>();
    const store = {
      getFileHash: () => undefined,
      saveFileHash: () => {},
      deleteFileHash: () => {},
      getCachedEmbedding: (k: string) => cache.get(k),
      saveCachedEmbedding: (k: string, v: number[]) => { cache.set(k, v); },
    };

    let calls = 0;
    vi.spyOn(OllamaClient.prototype, 'embed').mockImplementation(async () => {
      calls++;
      return new Array(768).fill(calls);
    });

    const file = path.join(tmpDir, 'a.ts');
    // Symbol body that, when concatenated with "function fn: <text>", does NOT
    // accidentally equal the query string we'll send below — so it tests the
    // mode separation, not text difference.
    fs.writeFileSync(file, `export function fn() { return 'x'; }`);

    const r = new GraphRetriever(store);
    await r.indexFile(file);

    // After indexing, cache has at least one document-mode entry.
    const docKeys = [...cache.keys()];
    expect(docKeys.length).toBeGreaterThan(0);

    // Now embed the SAME raw text as a query — must NOT hit the document
    // cache, because the cache key includes the mode.
    await r.retrieveContextItems('function fn: export function fn() { return \'x\'; }');

    const queryKeys = [...cache.keys()].filter(k => !docKeys.includes(k));
    expect(queryKeys.length).toBe(1);
    // The doc-mode cache entry must still be there — query path should not
    // overwrite it.
    for (const k of docKeys) expect(cache.has(k)).toBe(true);
  });
});
