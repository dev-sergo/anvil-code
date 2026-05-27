import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@rag-system/shared', async () => {
  const actual = await vi.importActual<typeof import('@rag-system/shared')>('@rag-system/shared');
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

// Mock Qdrant client — isolates tests from a running Qdrant instance.
const mockClient = {
  getCollections: vi.fn().mockResolvedValue({ collections: [] }),
  createCollection: vi.fn().mockResolvedValue({}),
  getCollection: vi.fn().mockResolvedValue({ points_count: 0 }),
  upsert: vi.fn().mockResolvedValue({}),
  delete: vi.fn().mockResolvedValue({}),
  search: vi.fn().mockResolvedValue([]),
};

vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: vi.fn(() => mockClient),
}));

const { QdrantVectorStore } = await import('../qdrant-vector-store.js');

describe('QdrantVectorStore (v1.47)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.getCollections.mockResolvedValue({ collections: [] });
    mockClient.getCollection.mockResolvedValue({ points_count: 0 });
    mockClient.search.mockResolvedValue([]);
  });

  it('creates a Qdrant collection on construction if it does not exist', async () => {
    const store = new QdrantVectorStore('/data/projects/abc/vectors', 'http://localhost:6333', 768);
    await store.loadFromDisk(); // await ready
    expect(mockClient.createCollection).toHaveBeenCalledTimes(1);
    const callArgs = mockClient.createCollection.mock.calls[0] as [string, unknown];
    expect(callArgs[0]).toMatch(/^anvil_/);
  });

  it('reuses existing collection without re-creating', async () => {
    // Last 2 path segments of '/data/projects/abc/vectors' → 'abc_vectors'
    mockClient.getCollections.mockResolvedValue({
      collections: [{ name: 'anvil_abc_vectors' }],
    });
    mockClient.getCollection.mockResolvedValue({ points_count: 42 });
    const store = new QdrantVectorStore('/data/projects/abc/vectors', 'http://localhost:6333', 768);
    await store.loadFromDisk();
    expect(mockClient.createCollection).not.toHaveBeenCalled();
    expect(store.size).toBe(42);
  });

  it('upserts a vector on add', async () => {
    const store = new QdrantVectorStore('/tmp/v', 'http://localhost:6333', 3);
    await store.loadFromDisk();
    await store.add('Symbol1', [0.1, 0.2, 0.3], { filePath: 'src/a.ts' });
    expect(mockClient.upsert).toHaveBeenCalledTimes(1);
    const points = (mockClient.upsert.mock.calls[0] as [string, { points: unknown[] }])[1].points;
    expect(points).toHaveLength(1);
    expect((points[0] as { payload: { symbolName: string } }).payload.symbolName).toBe('Symbol1');
  });

  it('deletes a point on removeById', async () => {
    const store = new QdrantVectorStore('/tmp/v', 'http://localhost:6333', 3);
    await store.loadFromDisk();
    await store.add('Sym', [1, 0, 0]);
    await store.removeById('Sym');
    expect(mockClient.delete).toHaveBeenCalledTimes(1);
  });

  it('searches and maps Qdrant similarity to distance', async () => {
    mockClient.search.mockResolvedValue([
      { id: 'uuid-1', score: 0.9, payload: { symbolName: 'MyFunc' } },
      { id: 'uuid-2', score: 0.7, payload: { symbolName: 'OtherFunc' } },
    ]);
    const store = new QdrantVectorStore('/tmp/v', 'http://localhost:6333', 3);
    await store.loadFromDisk();
    // Manually set _size so search doesn't short-circuit
    (store as unknown as { _size: number })._size = 5;
    const results = await store.search([1, 0, 0], 2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('MyFunc');
    expect(results[0].distance).toBeCloseTo(0.1); // 1 - 0.9
  });

  it('returns empty search when size is 0', async () => {
    const store = new QdrantVectorStore('/tmp/v', 'http://localhost:6333', 3);
    await store.loadFromDisk();
    const results = await store.search([1, 0, 0], 5);
    expect(results).toHaveLength(0);
    expect(mockClient.search).not.toHaveBeenCalled();
  });

  it('passes packageName filter to Qdrant when provided (v1.66)', async () => {
    mockClient.search.mockResolvedValue([
      { id: 'uuid-1', score: 0.8, payload: { symbolName: 'ServerFunc' } },
    ]);
    const store = new QdrantVectorStore('/tmp/v', 'http://localhost:6333', 3);
    await store.loadFromDisk();
    (store as unknown as { _size: number })._size = 10;
    await store.search([1, 0, 0], 5, { packageName: 'server' });
    const searchCall = mockClient.search.mock.calls[0] as [string, { filter?: { must: Array<{ key: string; match: { value: string } }> } }];
    expect(searchCall[1].filter).toBeDefined();
    expect(searchCall[1].filter!.must[0]!.key).toBe('packageName');
    expect(searchCall[1].filter!.must[0]!.match.value).toBe('server');
  });

  it('falls back to filePath filter when only filePath is given (backward compat)', async () => {
    mockClient.search.mockResolvedValue([]);
    const store = new QdrantVectorStore('/tmp/v', 'http://localhost:6333', 3);
    await store.loadFromDisk();
    (store as unknown as { _size: number })._size = 10;
    await store.search([1, 0, 0], 5, { filePath: 'packages/server/src' });
    const searchCall = mockClient.search.mock.calls[0] as [string, { filter?: { must: Array<{ key: string }> } }];
    expect(searchCall[1].filter).toBeDefined();
    expect(searchCall[1].filter!.must[0]!.key).toBe('filePath');
  });

  it('search without filter sends no Qdrant filter', async () => {
    mockClient.search.mockResolvedValue([]);
    const store = new QdrantVectorStore('/tmp/v', 'http://localhost:6333', 3);
    await store.loadFromDisk();
    (store as unknown as { _size: number })._size = 5;
    await store.search([1, 0, 0], 5);
    const searchCall = mockClient.search.mock.calls[0] as [string, { filter?: unknown }];
    expect(searchCall[1].filter).toBeUndefined();
  });

  it('save() is a no-op (Qdrant persists automatically)', async () => {
    const store = new QdrantVectorStore('/tmp/v', 'http://localhost:6333', 3);
    await store.save();
    // No Qdrant calls expected for save
    expect(mockClient.upsert).not.toHaveBeenCalled();
  });
});
