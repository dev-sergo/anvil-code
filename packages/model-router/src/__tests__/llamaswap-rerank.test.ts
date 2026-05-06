import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@rag-system/shared', async () => {
  const actual = await vi.importActual<typeof import('@rag-system/shared')>('@rag-system/shared');
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

const { LlamaSwapClient } = await import('../llamaswap-client.js');

function jsonResponse(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('LlamaSwapClient.rerank', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('returns results sorted DESC by relevance score', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        results: [
          { index: 0, relevance_score: -5.67 },
          { index: 1, relevance_score: -8.64 },
          { index: 2, relevance_score: -10.83 },
        ],
      }),
    );
    const c = new LlamaSwapClient('http://test');
    const results = await c.rerank('add health endpoint', ['getHealth()', 'createUser()', 'router'], 'reranker');
    expect(results).toHaveLength(3);
    expect(results[0].index).toBe(0);
    expect(results[0].relevanceScore).toBeCloseTo(-5.67);
    expect(results[1].index).toBe(1);
    expect(results[2].index).toBe(2);
  });

  it('reorders correctly when server returns out-of-relevance order', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        results: [
          { index: 0, relevance_score: -10.0 },
          { index: 1, relevance_score: -3.0 },
          { index: 2, relevance_score: -7.0 },
        ],
      }),
    );
    const c = new LlamaSwapClient('http://test');
    const results = await c.rerank('query', ['a', 'b', 'c'], 'reranker');
    expect(results.map(r => r.index)).toEqual([1, 2, 0]);
  });

  it('returns [] for empty documents without hitting the network', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const c = new LlamaSwapClient('http://test');
    const results = await c.rerank('query', [], 'reranker');
    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on non-2xx response', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('not_supported_error', { status: 501 }),
    );
    const c = new LlamaSwapClient('http://test');
    await expect(c.rerank('query', ['doc'], 'reranker')).rejects.toThrow(/501/);
  });
});
