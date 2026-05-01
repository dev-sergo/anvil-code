import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@rag-system/shared', async () => {
  const actual = await vi.importActual<typeof import('@rag-system/shared')>('@rag-system/shared');
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

const { LlamaSwapClient } = await import('../llamaswap-client.js');

/**
 * Build a fake fetch streaming response that emits the given body in chunks of
 * `chunkSize` bytes — exercises the SSE parser across buffer boundaries.
 */
function streamingFetchResponse(rawBody: string, chunkSize = 4) {
  const enc = new TextEncoder();
  const blob = enc.encode(rawBody);
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
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function sseEvent(obj: object): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe('LlamaSwapClient.chatStream — SSE parsing', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('yields content deltas in order', async () => {
    const body =
      sseEvent({ choices: [{ delta: { content: 'Hello' } }] }) +
      sseEvent({ choices: [{ delta: { content: ' world' } }] }) +
      sseEvent({ choices: [{ delta: { content: '!' } }] }) +
      'data: [DONE]\n\n';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(streamingFetchResponse(body, 8));

    const c = new LlamaSwapClient('http://x');
    const chunks: string[] = [];
    for await (const ch of c.chatStream([{ role: 'user', content: 'hi' }], 'coder')) chunks.push(ch);
    expect(chunks).toEqual(['Hello', ' world', '!']);
  });

  it('terminates on data: [DONE] without yielding extra', async () => {
    const body =
      sseEvent({ choices: [{ delta: { content: 'foo' } }] }) +
      'data: [DONE]\n\n' +
      sseEvent({ choices: [{ delta: { content: 'should-not-appear' } }] });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(streamingFetchResponse(body, 4));

    const c = new LlamaSwapClient('http://x');
    const chunks: string[] = [];
    for await (const ch of c.chatStream([{ role: 'user', content: 'hi' }], 'coder')) chunks.push(ch);
    expect(chunks).toEqual(['foo']);
  });

  it('handles chunks split mid-line and across `\\n\\n` event boundaries', async () => {
    const body =
      sseEvent({ choices: [{ delta: { content: 'aa' } }] }) +
      sseEvent({ choices: [{ delta: { content: 'bb' } }] }) +
      sseEvent({ choices: [{ delta: { content: 'cc' } }] }) +
      'data: [DONE]\n\n';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(streamingFetchResponse(body, 1));

    const c = new LlamaSwapClient('http://x');
    const chunks: string[] = [];
    for await (const ch of c.chatStream([{ role: 'user', content: 'hi' }], 'coder')) chunks.push(ch);
    expect(chunks.join('')).toBe('aabbcc');
  });

  it('skips malformed events without aborting the stream', async () => {
    const body =
      sseEvent({ choices: [{ delta: { content: 'good' } }] }) +
      'data: this is not json\n\n' +
      sseEvent({ choices: [{ delta: { content: 'still-good' } }] }) +
      'data: [DONE]\n\n';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(streamingFetchResponse(body, 8));

    const c = new LlamaSwapClient('http://x');
    const chunks: string[] = [];
    for await (const ch of c.chatStream([{ role: 'user', content: 'hi' }], 'coder')) chunks.push(ch);
    expect(chunks).toEqual(['good', 'still-good']);
  });

  it('skips non-data events (comments, keepalives)', async () => {
    const body =
      ': llama-swap keepalive\n\n' +
      sseEvent({ choices: [{ delta: { content: 'real' } }] }) +
      'data: [DONE]\n\n';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(streamingFetchResponse(body, 4));

    const c = new LlamaSwapClient('http://x');
    const chunks: string[] = [];
    for await (const ch of c.chatStream([{ role: 'user', content: 'hi' }], 'coder')) chunks.push(ch);
    expect(chunks).toEqual(['real']);
  });

  it('throws on non-2xx response', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response('boom', { status: 500 }));
    const c = new LlamaSwapClient('http://x');
    const it = c.chatStream([{ role: 'user', content: 'hi' }], 'coder')[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow(/500/);
  });
});
