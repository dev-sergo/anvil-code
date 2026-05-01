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

describe('LlamaSwapClient.embed', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('extracts data[0].embedding from OpenAI shape', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }], model: 'embed' }),
    );
    const c = new LlamaSwapClient('http://test');
    const v = await c.embed('hello', 'embed');
    expect(v).toEqual([0.1, 0.2, 0.3]);
  });

  it('throws on non-2xx', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('boom', { status: 502 }));
    const c = new LlamaSwapClient('http://test');
    await expect(c.embed('hi', 'embed')).rejects.toThrow(/502/);
  });

  it('throws when response has no embedding', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({ data: [] }));
    const c = new LlamaSwapClient('http://test');
    await expect(c.embed('hi', 'embed')).rejects.toThrow(/no embedding/);
  });
});

describe('LlamaSwapClient.embedBatch', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('returns one embedding per input, ordered by `index`', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        data: [
          { embedding: [3, 3, 3], index: 2 },
          { embedding: [1, 1, 1], index: 0 },
          { embedding: [2, 2, 2], index: 1 },
        ],
        model: 'embed',
      }),
    );
    const c = new LlamaSwapClient('http://test');
    const v = await c.embedBatch(['a', 'b', 'c'], 'embed');
    expect(v).toEqual([[1, 1, 1], [2, 2, 2], [3, 3, 3]]);
  });

  it('returns [] for empty input without hitting the network', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const c = new LlamaSwapClient('http://test');
    const v = await c.embedBatch([], 'embed');
    expect(v).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when the server returns a wrong-length result', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ data: [{ embedding: [0.1], index: 0 }] }),
    );
    const c = new LlamaSwapClient('http://test');
    await expect(c.embedBatch(['a', 'b'], 'embed')).rejects.toThrow(/expected 2/);
  });
});
