import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@rag-system/shared', async () => {
  const actual = await vi.importActual<typeof import('@rag-system/shared')>('@rag-system/shared');
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

const { OllamaClient } = await import('../ollama-client.js');

function streamingFetchResponse(lines: string[], chunkSize = 1) {
  // Encode lines (joined with \n) and emit as small Uint8Array chunks so the parser
  // is exercised across buffer boundaries.
  const enc = new TextEncoder();
  const blob = enc.encode(lines.join('\n') + '\n');
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= blob.length) {
        controller.close();
        return;
      }
      const end = Math.min(blob.length, offset + chunkSize);
      controller.enqueue(blob.slice(offset, end));
      offset = end;
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

describe('OllamaClient.chatStream', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('yields content deltas in order', async () => {
    const lines = [
      JSON.stringify({ message: { role: 'assistant', content: 'Hello' }, done: false }),
      JSON.stringify({ message: { role: 'assistant', content: ' world' }, done: false }),
      JSON.stringify({ message: { role: 'assistant', content: '!' }, done: true }),
    ];
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(streamingFetchResponse(lines, 4));

    const client = new OllamaClient('http://x');
    const chunks: string[] = [];
    for await (const c of client.chatStream([{ role: 'user', content: 'hi' }], 'm')) chunks.push(c);
    expect(chunks).toEqual(['Hello', ' world', '!']);
  });

  it('handles chunks split mid-line across reads', async () => {
    const lines = [
      JSON.stringify({ message: { role: 'assistant', content: 'foo' }, done: false }),
      JSON.stringify({ message: { role: 'assistant', content: 'bar' }, done: true }),
    ];
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(streamingFetchResponse(lines, 1));

    const client = new OllamaClient('http://x');
    const chunks: string[] = [];
    for await (const c of client.chatStream([{ role: 'user', content: 'hi' }], 'm')) chunks.push(c);
    expect(chunks.join('')).toBe('foobar');
  });

  it('skips malformed lines without aborting the stream', async () => {
    const lines = [
      JSON.stringify({ message: { role: 'assistant', content: 'good' }, done: false }),
      'this is not json {',
      JSON.stringify({ message: { role: 'assistant', content: 'still good' }, done: true }),
    ];
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(streamingFetchResponse(lines, 8));

    const client = new OllamaClient('http://x');
    const chunks: string[] = [];
    for await (const c of client.chatStream([{ role: 'user', content: 'hi' }], 'm')) chunks.push(c);
    expect(chunks).toEqual(['good', 'still good']);
  });

  it('throws on non-2xx response', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('boom', { status: 500 }),
    );
    const client = new OllamaClient('http://x');
    const iter = client.chatStream([{ role: 'user', content: 'hi' }], 'm')[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(/500/);
  });
});
