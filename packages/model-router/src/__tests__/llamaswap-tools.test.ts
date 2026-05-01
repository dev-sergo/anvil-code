import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@rag-system/shared', async () => {
  const actual = await vi.importActual<typeof import('@rag-system/shared')>('@rag-system/shared');
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

const { LlamaSwapClient } = await import('../llamaswap-client.js');
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
      description: 'Read a file',
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

describe('LlamaSwapClient.chatWithTools — OpenAI tool_calls path', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('parses arguments JSON string back into an object', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } },
            ],
          },
        }],
      }),
    );

    const c = new LlamaSwapClient('http://test');
    const r = await c.chatWithTools(MESSAGES, TOOLS, 'coder');
    expect(r.toolCalls).toBeDefined();
    expect(r.toolCalls!).toHaveLength(1);
    expect(r.toolCalls![0].function.name).toBe('read_file');
    expect(r.toolCalls![0].function.arguments).toEqual({ path: 'src/a.ts' });
  });

  it('accepts already-parsed object arguments (lenient server)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'done', arguments: {} } }],
          },
        }],
      }),
    );

    const c = new LlamaSwapClient('http://test');
    const r = await c.chatWithTools(MESSAGES, TOOLS, 'coder');
    expect(r.toolCalls![0].function.arguments).toEqual({});
  });

  it('returns empty-args object when arguments is malformed JSON (graceful fallback)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'read_file', arguments: '{this is not json' } }],
          },
        }],
      }),
    );
    const c = new LlamaSwapClient('http://test');
    const r = await c.chatWithTools(MESSAGES, TOOLS, 'coder');
    expect(r.toolCalls![0].function.arguments).toEqual({});
  });
});

describe('LlamaSwapClient.chatWithTools — inline-content fallback', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('extracts tool calls from content when tool_calls field is absent (qwen-coder pattern)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        choices: [{
          message: {
            role: 'assistant',
            content: '{"name": "read_file", "arguments": {"path": "src/main.ts"}}\n{"name": "done", "arguments": {}}',
          },
        }],
      }),
    );

    const c = new LlamaSwapClient('http://test');
    const r = await c.chatWithTools(MESSAGES, TOOLS, 'coder');
    expect(r.toolCalls).toBeDefined();
    expect(r.toolCalls!).toHaveLength(2);
    expect(r.toolCalls![0].function.name).toBe('read_file');
    expect(r.toolCalls![0].function.arguments).toEqual({ path: 'src/main.ts' });
    expect(r.toolCalls![1].function.name).toBe('done');
  });

  it('returns plain content when no tool calls (text-only response)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'just text, no tools' } }],
      }),
    );
    const c = new LlamaSwapClient('http://test');
    const r = await c.chatWithTools(MESSAGES, TOOLS, 'coder');
    expect(r.toolCalls).toBeUndefined();
    expect(r.content).toBe('just text, no tools');
  });
});

describe('LlamaSwapClient.chatWithTools — request shaping', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('sends assistant.tool_calls back with id+type and stringified arguments', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));

    const c = new LlamaSwapClient('http://test');
    await c.chatWithTools(
      [
        { role: 'user', content: 'do' },
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'src/a.ts' } } }] },
        { role: 'tool', content: 'file content', tool_name: 'read_file' },
      ],
      TOOLS,
      'coder',
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    const assistantMsg = body.messages[1];
    expect(assistantMsg.tool_calls[0]).toEqual({
      id: 'call_0',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' },
    });
    const toolMsg = body.messages[2];
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.tool_call_id).toBeDefined();
  });
});
