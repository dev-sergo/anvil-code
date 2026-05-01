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

describe('LlamaSwapClient.chat', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('returns content from choices[0].message.content', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'Hello world' }, finish_reason: 'stop' }],
        model: 'coder',
      }),
    );
    const c = new LlamaSwapClient('http://test');
    const r = await c.chat([{ role: 'user', content: 'hi' }], 'coder');
    expect(r).toBe('Hello world');
  });

  it('passes temperature + jsonMode → response_format', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { role: 'assistant', content: '{}' } }] }));
    const c = new LlamaSwapClient('http://test');
    await c.chat([{ role: 'user', content: 'x' }], 'coder', { temperature: 0.2, jsonMode: true });
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.temperature).toBe(0.2);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.stream).toBe(false);
  });

  it('throws on non-2xx', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const c = new LlamaSwapClient('http://test');
    await expect(c.chat([{ role: 'user', content: 'x' }], 'coder')).rejects.toThrow(/500/);
  });

  it('returns empty string when choices is empty (defensive)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({ choices: [] }));
    const c = new LlamaSwapClient('http://test');
    const r = await c.chat([{ role: 'user', content: 'x' }], 'coder');
    expect(r).toBe('');
  });
});

describe('LlamaSwapClient.healthCheck', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('returns true on /health 200', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const c = new LlamaSwapClient('http://test');
    expect(await c.healthCheck()).toBe(true);
  });

  it('returns false on network error', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('connection refused'));
    const c = new LlamaSwapClient('http://test');
    expect(await c.healthCheck()).toBe(false);
  });

  it('hits the /health path on the configured base URL', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const c = new LlamaSwapClient('http://my-host:9090');
    await c.healthCheck();
    expect(fetchMock.mock.calls[0][0]).toBe('http://my-host:9090/health');
  });
});
