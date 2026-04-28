import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@rag-system/shared', async () => {
  const actual = await vi.importActual<typeof import('@rag-system/shared')>('@rag-system/shared');
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

const { OllamaClient } = await import('../ollama-client.js');
import type { ToolDefinition, ToolLoopMessage } from '../types.js';

function jsonResponse(body: object) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: 'Finish',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

const MESSAGES: ToolLoopMessage[] = [{ role: 'user', content: 'do it' }];

describe('OllamaClient.chatWithTools — structured tool_calls path', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('returns tool calls when Ollama populates the structured tool_calls field', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { function: { name: 'read_file', arguments: { path: 'src/a.ts' } } },
          ],
        },
        done: true,
      }),
    );

    const client = new OllamaClient('http://test');
    const r = await client.chatWithTools(MESSAGES, TOOLS, 'model');
    expect(r.toolCalls).toBeDefined();
    expect(r.toolCalls!).toHaveLength(1);
    expect(r.toolCalls![0].function.name).toBe('read_file');
    expect(r.toolCalls![0].function.arguments).toEqual({ path: 'src/a.ts' });
  });
});

describe('OllamaClient.chatWithTools — inline-content fallback', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('extracts tool calls from message.content when tool_calls field is absent (qwen2.5-coder pattern)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        message: {
          role: 'assistant',
          content: '{"name": "read_file", "arguments": {"path": "src/main.ts"}}\n{"name": "done", "arguments": {}}',
        },
        done: true,
      }),
    );

    const client = new OllamaClient('http://test');
    const r = await client.chatWithTools(MESSAGES, TOOLS, 'model');
    expect(r.toolCalls).toBeDefined();
    expect(r.toolCalls!).toHaveLength(2);
    expect(r.toolCalls![0].function.name).toBe('read_file');
    expect(r.toolCalls![0].function.arguments).toEqual({ path: 'src/main.ts' });
    expect(r.toolCalls![1].function.name).toBe('done');
    expect(r.toolCalls![1].function.arguments).toEqual({});
  });

  it('handles prose around inline tool calls', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        message: {
          role: 'assistant',
          content: 'Sure, I will read the file first. {"name": "read_file", "arguments": {"path": "x.ts"}} Then done.',
        },
        done: true,
      }),
    );

    const client = new OllamaClient('http://test');
    const r = await client.chatWithTools(MESSAGES, TOOLS, 'model');
    expect(r.toolCalls).toBeDefined();
    expect(r.toolCalls!).toHaveLength(1);
    expect(r.toolCalls![0].function.name).toBe('read_file');
  });

  it('survives JSON-shaped strings in arguments (string-aware brace counter)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        message: {
          role: 'assistant',
          content: '{"name": "create_file", "arguments": {"path": "x.ts", "content": "if (x) { return { ok: true }; }"}}',
        },
        done: true,
      }),
    );

    const client = new OllamaClient('http://test');
    const r = await client.chatWithTools(MESSAGES, TOOLS, 'model');
    expect(r.toolCalls).toBeDefined();
    expect(r.toolCalls!).toHaveLength(1);
    expect(r.toolCalls![0].function.arguments).toEqual({
      path: 'x.ts',
      content: 'if (x) { return { ok: true }; }',
    });
  });

  it('returns no tool calls when content is pure prose', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        message: { role: 'assistant', content: 'I cannot do this without more information.' },
        done: true,
      }),
    );

    const client = new OllamaClient('http://test');
    const r = await client.chatWithTools(MESSAGES, TOOLS, 'model');
    expect(r.toolCalls).toBeUndefined();
    expect(r.content).toBe('I cannot do this without more information.');
  });

  it('skips JSON objects that lack the {name, arguments} shape', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        message: {
          role: 'assistant',
          content: '{"random": "object"} {"name": "done", "arguments": {}} {"otherShape": 1}',
        },
        done: true,
      }),
    );

    const client = new OllamaClient('http://test');
    const r = await client.chatWithTools(MESSAGES, TOOLS, 'model');
    expect(r.toolCalls).toBeDefined();
    expect(r.toolCalls!).toHaveLength(1);
    expect(r.toolCalls![0].function.name).toBe('done');
  });
});
