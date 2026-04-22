import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock hnswlib-node (native module — avoid loading in tests)
const points = new Map<number, number[]>();
const mockIndex = {
  initIndex: vi.fn(),
  resizeIndex: vi.fn(),
  addPoint: vi.fn((vector: number[], label: number) => { points.set(label, vector); }),
  searchKnn: vi.fn((vector: number[], k: number) => {
    // Return the k most recently added labels as neighbors
    const labels = [...points.keys()].slice(-k);
    return { neighbors: labels, distances: labels.map(() => 0.1) };
  }),
  writeIndexSync: vi.fn(),
  readIndexSync: vi.fn(),
};

vi.mock('hnswlib-node', () => ({
  HierarchicalNSW: vi.fn(() => mockIndex),
}));

vi.mock('@rag-system/shared', () => ({
  config: {
    rag: { embeddingDim: 4, maxElements: 100, vectorsPath: '/tmp/test-vectors' },
  },
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => '{}'),
  };
});

vi.mock('fs/promises', () => ({
  writeFile: vi.fn(),
}));

const { VectorStore } = await import('../vector-store.js');

describe('VectorStore', () => {
  let store: InstanceType<typeof VectorStore>;

  beforeEach(() => {
    points.clear();
    vi.clearAllMocks();
    store = new VectorStore('/tmp/test-vectors');
  });

  // ── add / search round-trip ───────────────────────────────────────────────

  it('adds a vector and returns it in search results', async () => {
    await store.add('sym:foo', [0.1, 0.2, 0.3, 0.4]);
    const results = await store.search([0.1, 0.2, 0.3, 0.4], 5);
    expect(results.map(r => r.id)).toContain('sym:foo');
  });

  it('tracks size correctly', async () => {
    expect(store.size).toBe(0);
    await store.add('a', [1, 0, 0, 0]);
    expect(store.size).toBe(1);
    await store.add('b', [0, 1, 0, 0]);
    expect(store.size).toBe(2);
  });

  it('ignores duplicate id on second add', async () => {
    await store.add('sym:foo', [0.1, 0.2, 0.3, 0.4]);
    await store.add('sym:foo', [0.5, 0.6, 0.7, 0.8]); // duplicate
    expect(store.size).toBe(1); // still 1
  });

  it('stores metadata and returns it in search results', async () => {
    await store.add('sym:bar', [0, 0, 1, 0], { filePath: 'src/bar.ts', kind: 'function' });
    const results = await store.search([0, 0, 1, 0], 1);
    const result = results.find(r => r.id === 'sym:bar');
    expect(result?.metadata).toMatchObject({ filePath: 'src/bar.ts' });
  });

  // ── concurrent add safety ─────────────────────────────────────────────────

  it('does not assign duplicate labels under concurrent adds', async () => {
    const addPromises = Array.from({ length: 10 }, (_, i) =>
      store.add(`sym:${i}`, [i / 10, 0, 0, 0])
    );
    await Promise.all(addPromises);
    expect(store.size).toBe(10);
    // All labels should be unique: size equals number of distinct entries
    const results = await store.search([0.5, 0, 0, 0], 10);
    const ids = new Set(results.map(r => r.id));
    // Each id should appear at most once
    expect(ids.size).toBe(results.length);
  });

  // ── empty store ───────────────────────────────────────────────────────────

  it('returns empty array when store is empty', async () => {
    const results = await store.search([1, 0, 0, 0], 5);
    expect(results).toEqual([]);
  });
});
