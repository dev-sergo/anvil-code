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
      rag: {
        ...actual.config.rag,
        embedConcurrency: 4,
        maxContextTokens: 8000,
        rerankerEnabled: false,
        bm25Enabled: false,
      },
    },
  };
});

vi.mock('hnswlib-node', () => ({
  HierarchicalNSW: class {
    initIndex(): void {}
    resizeIndex(): void {}
    addPoint(): void {}
    searchKnn(): { neighbors: number[]; distances: number[] } { return { neighbors: [], distances: [] }; }
    writeIndexSync(): void {}
    readIndexSync(): void {}
    markDelete(): void {}
  },
}));

const { GraphRetriever } = await import('../graph-retriever.js');

type GraphRetrieverPrivate = {
  monorepoMeta: string | null;
  graphsDir: string;
  indexMonorepoMeta(rootDir: string): Promise<void>;
};

let tmpRoot: string;
let tmpGraphs: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-meta-test-'));
  tmpGraphs = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-graphs-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(tmpGraphs, { recursive: true, force: true });
});

describe('GraphRetriever monorepo meta (v1.42)', () => {
  it('parses tsconfig.json paths into meta text', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        paths: {
          '@myapp/server': ['./packages/server/src'],
          '@myapp/server/*': ['./packages/server/src/*'],
          '@myapp/client': ['./packages/client/src'],
        },
      },
    }));

    const retriever = new GraphRetriever(undefined, { graphsDir: tmpGraphs });
    const priv = retriever as unknown as GraphRetrieverPrivate;
    await priv.indexMonorepoMeta(tmpRoot);

    expect(priv.monorepoMeta).not.toBeNull();
    expect(priv.monorepoMeta).toContain('@myapp/server →');
    expect(priv.monorepoMeta).toContain('@myapp/client →');
    // Wildcard duplicate should be suppressed if non-wildcard already present
    expect(priv.monorepoMeta).not.toMatch(/@myapp\/server\/\* →/);
    expect(priv.monorepoMeta).toContain('TypeScript module aliases');
  });

  it('parses packages/*/package.json exports', async () => {
    const pkgDir = path.join(tmpRoot, 'packages', 'server');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@myapp/server',
      exports: {
        '.': './dist/index.cjs',
        './adapters/express': './dist/adapters/express.cjs',
        './adapters/fastify': './dist/adapters/fastify.cjs',
      },
    }));

    const retriever = new GraphRetriever(undefined, { graphsDir: tmpGraphs });
    const priv = retriever as unknown as GraphRetrieverPrivate;
    await priv.indexMonorepoMeta(tmpRoot);

    expect(priv.monorepoMeta).not.toBeNull();
    expect(priv.monorepoMeta).toContain('@myapp/server:');
    expect(priv.monorepoMeta).toContain('./adapters/express');
  });

  it('persists meta to graphsDir and reloads on construction', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { paths: { '@pkg/core': ['./packages/core/src'] } },
    }));

    // Write meta via indexMonorepoMeta
    const r1 = new GraphRetriever(undefined, { graphsDir: tmpGraphs });
    await (r1 as unknown as GraphRetrieverPrivate).indexMonorepoMeta(tmpRoot);
    expect((r1 as unknown as GraphRetrieverPrivate).monorepoMeta).toContain('@pkg/core');

    // New instance should reload from disk without re-indexing
    const r2 = new GraphRetriever(undefined, { graphsDir: tmpGraphs });
    expect((r2 as unknown as GraphRetrieverPrivate).monorepoMeta).toContain('@pkg/core');
  });

  it('returns meta as ContextItem when vectorStore is empty but meta exists', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { paths: { '@svc/api': ['./services/api/src'] } },
    }));

    const retriever = new GraphRetriever(undefined, { graphsDir: tmpGraphs });
    const priv = retriever as unknown as GraphRetrieverPrivate;
    await priv.indexMonorepoMeta(tmpRoot);

    // vectorStore is empty — but meta should still appear in results
    const items = await retriever.retrieveContextItems('add import from api service');
    expect(items.length).toBe(1);
    expect(items[0].symbolName).toBe('__monorepo_imports__');
    expect(items[0].filePath).toBe('tsconfig.json');
    expect(items[0].text).toContain('@svc/api');
  });

  it('returns empty when no tsconfig paths and no packages', async () => {
    const retriever = new GraphRetriever(undefined, { graphsDir: tmpGraphs });
    const priv = retriever as unknown as GraphRetrieverPrivate;
    await priv.indexMonorepoMeta(tmpRoot);

    expect(priv.monorepoMeta).toBeNull();
    const items = await retriever.retrieveContextItems('anything');
    expect(items).toHaveLength(0);
  });
});
