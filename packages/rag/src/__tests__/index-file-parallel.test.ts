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
      rag: { ...actual.config.rag, embedConcurrency: 4 },
    },
  };
});

// HNSW native binding is slow to spin up in tests — stub it.
vi.mock('hnswlib-node', async () => {
  const { writeFileSync } = await import('fs');
  return {
    HierarchicalNSW: class {
      initIndex(): void {}
      resizeIndex(): void {}
      addPoint(): void {}
      searchKnn(): { neighbors: number[]; distances: number[] } { return { neighbors: [], distances: [] }; }
      writeIndexSync(p: string): void { writeFileSync(p, ''); }
      readIndexSync(): void {}
      markDelete(): void {}
    },
  };
});

const { GraphRetriever } = await import('../graph-retriever.js');
const { OllamaClient } = await import('@rag-system/model-router');

describe('GraphRetriever.indexFile parallel embed', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-par-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs embed calls concurrently up to the cap (peak in-flight ≤ embedConcurrency)', async () => {
    const file = path.join(tmpDir, 'big.ts');
    // 12 symbols → with concurrency 4, expect peak in-flight = 4
    const symbols = Array.from({ length: 12 }, (_, i) =>
      `export function fn${i}() { return ${i}; }`,
    ).join('\n\n');
    fs.writeFileSync(file, symbols);

    let inFlight = 0;
    let peak = 0;
    const embedSpy = vi.spyOn(OllamaClient.prototype, 'embed').mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise(r => setTimeout(r, 25));
        return new Array(768).fill(0);
      } finally {
        inFlight--;
      }
    });

    try {
      const retriever = new GraphRetriever();
      await retriever.indexFile(file);
      expect(embedSpy).toHaveBeenCalledTimes(12);
      expect(peak).toBe(4);
    } finally {
      embedSpy.mockRestore();
    }
  });

  it('finishes faster than the strict serial baseline', async () => {
    const file = path.join(tmpDir, 'medium.ts');
    const symbols = Array.from({ length: 8 }, (_, i) =>
      `export function fn${i}() { return ${i}; }`,
    ).join('\n\n');
    fs.writeFileSync(file, symbols);

    const embedSpy = vi.spyOn(OllamaClient.prototype, 'embed').mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 30));
      return new Array(768).fill(0);
    });

    try {
      const retriever = new GraphRetriever();
      const start = Date.now();
      await retriever.indexFile(file);
      const elapsed = Date.now() - start;
      // 8 symbols × 30ms serial = 240ms. With concurrency 4 the lower bound is ~60-80ms.
      // Use a loose ceiling so test-runner jitter (CI cold start, GC) doesn't flake;
      // the strict serial baseline is the floor we must beat.
      expect(elapsed).toBeLessThan(220);
    } finally {
      embedSpy.mockRestore();
    }
  });

  it('continues indexing the remaining symbols when one embed throws', async () => {
    const file = path.join(tmpDir, 'flaky.ts');
    fs.writeFileSync(
      file,
      Array.from({ length: 5 }, (_, i) => `export function fn${i}() {}`).join('\n\n'),
    );

    let calls = 0;
    const embedSpy = vi.spyOn(OllamaClient.prototype, 'embed').mockImplementation(async () => {
      calls++;
      if (calls === 2) throw new Error('Ollama transient error');
      return new Array(768).fill(0);
    });

    try {
      const retriever = new GraphRetriever();
      await expect(retriever.indexFile(file)).resolves.toBeUndefined();
      // All 5 attempted even though one threw
      expect(embedSpy).toHaveBeenCalledTimes(5);
    } finally {
      embedSpy.mockRestore();
    }
  });

  it('no-op for a file with no symbols', async () => {
    const file = path.join(tmpDir, 'empty.md');
    fs.writeFileSync(file, '# notes only');

    const embedSpy = vi.spyOn(OllamaClient.prototype, 'embed');
    try {
      const retriever = new GraphRetriever();
      await retriever.indexFile(file);
      expect(embedSpy).not.toHaveBeenCalled();
    } finally {
      embedSpy.mockRestore();
    }
  });
});
