import { config, logger } from '@rag-system/shared';
import type { AgentMessage } from '@rag-system/shared';
import type { GenerateOptions, ToolCallResponse, ToolDefinition, ToolLoopMessage } from './types.js';
import type { ModelBackend } from './backend.js';
import { extractInlineToolCalls } from './shared-helpers.js';

/**
 * llama-swap (OpenAI-compatible) HTTP client. Talks to the proxy at
 * `config.llamacpp.url` which fronts one or more llama-server processes and
 * auto-loads the model named in the request body's `model` field.
 *
 * Endpoints used:
 *   POST /v1/chat/completions           — chat (sync + SSE streaming + tools)
 *   POST /v1/embeddings                 — embedding (single or batch input)
 *   GET  /health                        — liveness probe
 *
 * Wire shape differences from Ollama (v1.32-d migration notes):
 *   - Stream is SSE (`data: {...}\n\n`, terminator `data: [DONE]`), not NDJSON.
 *   - Tool calls live at `choices[0].message.tool_calls`; `function.arguments`
 *     is a JSON STRING per OpenAI spec — we parse it back to an object so the
 *     dispatcher contract stays the same as Ollama's already-structured shape.
 *   - Inline-tool-calls fallback ([extractInlineToolCalls]) is preserved —
 *     qwen-family models emit calls as JSON in `content` regardless of backend.
 *   - JSON mode uses `response_format: {"type":"json_object"}`, not `format:"json"`.
 *   - Embedding response is `{data:[{embedding}]}` (OpenAI), not `{embedding}`.
 */

interface OpenAIMessage {
  role: string;
  content: string;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIToolCall {
  id?: string;
  type?: string;
  function: {
    name: string;
    /** OpenAI spec: JSON string. Some servers may already pre-parse to object. */
    arguments: string | Record<string, unknown>;
  };
}

interface OpenAIChatChoice {
  message: OpenAIMessage;
  finish_reason?: string;
}

interface OpenAIChatResponse {
  choices: OpenAIChatChoice[];
  model?: string;
}

interface OpenAIStreamDelta {
  content?: string;
}

interface OpenAIStreamChoice {
  delta: OpenAIStreamDelta;
  finish_reason?: string | null;
}

interface OpenAIStreamChunk {
  choices: OpenAIStreamChoice[];
}

interface OpenAIEmbedResponseEntry {
  embedding: number[];
  index?: number;
}

interface OpenAIEmbedResponse {
  data: OpenAIEmbedResponseEntry[];
  model?: string;
}

export class LlamaSwapClient implements ModelBackend {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? config.llamacpp.url;
  }

  async chat(messages: AgentMessage[], model: string, options: GenerateOptions = {}): Promise<string> {
    const body = {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: false,
      ...(options.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    };

    logger.debug({ model, messages: messages.length, url: this.baseUrl }, 'llama-swap /v1/chat/completions');

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`llama-swap /v1/chat/completions ${res.status}: ${text}`);
    }

    const data = await res.json() as OpenAIChatResponse;
    return data.choices[0]?.message?.content ?? '';
  }

  async *chatStream(
    messages: AgentMessage[],
    model: string,
    options: GenerateOptions = {},
  ): AsyncIterable<string> {
    const body = {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true,
      ...(options.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    };

    logger.debug({ model, messages: messages.length, url: this.baseUrl }, 'llama-swap /v1/chat/completions (stream)');

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`llama-swap /v1/chat/completions ${res.status}: ${text}`);
    }
    if (!res.body) {
      throw new Error('llama-swap /v1/chat/completions returned no body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: !done });
        // SSE event boundary is `\n\n`. We process complete events; partial
        // events stay in buf until the next read fills them.
        let idx = buf.indexOf('\n\n');
        while (idx >= 0) {
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const chunk = parseSseEvent(event);
          if (chunk === DONE) return;
          if (chunk !== null) yield chunk;
          idx = buf.indexOf('\n\n');
        }
        if (done) {
          // Some servers may not send a trailing blank line. Process whatever's
          // left, in case it's a complete final event.
          const tail = buf.trim();
          if (tail) {
            const chunk = parseSseEvent(tail);
            if (chunk !== DONE && chunk !== null) yield chunk;
          }
          return;
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  async chatWithTools(
    messages: ToolLoopMessage[],
    tools: ToolDefinition[],
    model: string,
    options: GenerateOptions = {},
  ): Promise<ToolCallResponse> {
    // OpenAI requires `tool_calls[i].id` to be echoed back on tool messages. We
    // synthesize ids if the model didn't send any (some llama-swap models emit
    // tool_calls without an id) and pair them on tool replies. For loops where
    // the caller already tracked ids, we pass through unchanged.
    const body = {
      model,
      messages: messages.map(m => {
        if (m.role === 'assistant' && m.tool_calls) {
          return {
            role: 'assistant' as const,
            content: m.content ?? '',
            tool_calls: m.tool_calls.map((tc, i) => ({
              id: `call_${i}`,
              type: 'function' as const,
              function: {
                name: tc.function.name,
                arguments: typeof tc.function.arguments === 'string'
                  ? tc.function.arguments
                  : JSON.stringify(tc.function.arguments),
              },
            })),
          };
        }
        if (m.role === 'tool') {
          // OpenAI requires a tool_call_id; re-derive a placeholder. Most
          // models accept this without strict id matching against the prior
          // assistant turn — verified for qwen-coder.
          return {
            role: 'tool' as const,
            content: m.content,
            tool_call_id: m.tool_name ? `call_${m.tool_name}` : 'call_0',
          };
        }
        return { role: m.role, content: m.content };
      }),
      tools,
      stream: false,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    };

    logger.debug({ model, messages: messages.length, tools: tools.length, url: this.baseUrl }, 'llama-swap /v1/chat/completions (tools)');

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`llama-swap /v1/chat/completions (tools) ${res.status}: ${text}`);
    }

    const data = await res.json() as OpenAIChatResponse;
    const message = data.choices[0]?.message;
    const content = message?.content ?? '';
    const rawToolCalls = message?.tool_calls;

    let toolCalls = rawToolCalls && rawToolCalls.length > 0
      ? rawToolCalls.map(tc => ({
          function: {
            name: tc.function.name,
            // OpenAI spec: arguments is a string; some servers pre-parse. Handle both.
            arguments: typeof tc.function.arguments === 'string'
              ? safeParseJsonObject(tc.function.arguments)
              : tc.function.arguments,
          },
        }))
      : undefined;

    // Same fallback as Ollama path: qwen-family models sometimes emit tool
    // calls as JSON in `content` regardless of backend. Recovery is identical.
    if (!toolCalls && content) {
      const extracted = extractInlineToolCalls(content);
      if (extracted.length > 0) {
        logger.debug({ count: extracted.length }, 'Recovered tool calls from message content (model used inline JSON)');
        toolCalls = extracted;
      }
    }

    return { content, toolCalls, model: data.model ?? model };
  }

  async embed(text: string, model?: string): Promise<number[]> {
    const embedModel = model ?? config.llamacpp.modelEmbed;

    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embedModel, input: text }),
    });

    if (!res.ok) {
      const raw = await res.text();
      throw new Error(`llama-swap /v1/embeddings ${res.status}: ${raw}`);
    }

    const data = await res.json() as OpenAIEmbedResponse;
    const embedding = data.data?.[0]?.embedding;
    if (!embedding) {
      throw new Error('llama-swap /v1/embeddings returned no embedding');
    }
    return embedding;
  }

  /**
   * Batch-embedding variant. Not part of the ModelBackend contract because the
   * Ollama path doesn't support it natively — caller code that wants batches
   * goes through this method explicitly. v1.32-d Phase D may use this in the
   * indexing path to amortize round-trips.
   */
  async embedBatch(texts: string[], model?: string): Promise<number[][]> {
    if (texts.length === 0) return [];
    const embedModel = model ?? config.llamacpp.modelEmbed;

    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embedModel, input: texts }),
    });

    if (!res.ok) {
      const raw = await res.text();
      throw new Error(`llama-swap /v1/embeddings (batch) ${res.status}: ${raw}`);
    }

    const data = await res.json() as OpenAIEmbedResponse;
    if (!Array.isArray(data.data) || data.data.length !== texts.length) {
      throw new Error(`llama-swap /v1/embeddings: expected ${texts.length} embeddings, got ${data.data?.length ?? 0}`);
    }
    // Server is allowed to reorder via `index`; sort defensively before returning.
    const sorted = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map(e => e.embedding);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

const DONE = Symbol('sse-done');

/**
 * Parse one SSE event (everything between two `\n\n` boundaries). Returns:
 *   - DONE sentinel when `data: [DONE]` is seen — caller terminates the stream
 *   - extracted content delta string (possibly empty) for normal data events
 *   - null when the event is non-data (comment, keepalive, etc.)
 */
function parseSseEvent(event: string): string | null | typeof DONE {
  // SSE event = one or more lines. We care about `data:` lines.
  const lines = event.split('\n');
  const dataParts: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.startsWith('data:')) continue;
    // `data: <payload>` — single space after colon is standard but not required.
    const payload = line.slice(5).replace(/^ /, '');
    dataParts.push(payload);
  }
  if (dataParts.length === 0) return null;

  const joined = dataParts.join('\n');
  if (joined.trim() === '[DONE]') return DONE;

  try {
    const obj = JSON.parse(joined) as OpenAIStreamChunk;
    return obj.choices?.[0]?.delta?.content ?? '';
  } catch (err) {
    logger.debug({ event, error: String(err) }, 'Skipping malformed llama-swap SSE event');
    return null;
  }
}

function safeParseJsonObject(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* fall through */ }
  // Some models emit `arguments` as a partially-broken JSON string; return {}
  // rather than throwing so the dispatcher still sees the call (it can decide
  // how to error on bad args). Logging would be too noisy here — caller can
  // surface its own error if args are missing.
  return {};
}
