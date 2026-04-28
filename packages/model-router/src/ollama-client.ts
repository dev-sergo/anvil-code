import { config, logger } from '@rag-system/shared';
import type { AgentMessage } from '@rag-system/shared';
import type { GenerateOptions, ToolCallResponse, ToolDefinition, ToolLoopMessage } from './types.js';

interface OllamaChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  stream: boolean;
  format?: 'json';
  options?: { temperature?: number };
}

interface OllamaChatResponse {
  message: { role: string; content: string };
  done: boolean;
}

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaToolMessage {
  role: string;
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolChatResponse {
  message: OllamaToolMessage;
  done: boolean;
}

interface OllamaToolChatRequest {
  model: string;
  messages: Array<{
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  }>;
  tools: ToolDefinition[];
  stream: false;
  options?: { temperature?: number };
}

interface OllamaEmbedResponse {
  embedding: number[];
}

export class OllamaClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? config.ollama.baseUrl;
  }

  async chat(messages: AgentMessage[], model: string, options: GenerateOptions = {}): Promise<string> {
    const body: OllamaChatRequest = {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: false,
      ...(options.jsonMode ? { format: 'json' } : {}),
      ...(options.temperature !== undefined ? { options: { temperature: options.temperature } } : {}),
    };

    logger.debug({ model, messages: messages.length }, 'Ollama /api/chat');

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama /api/chat ${res.status}: ${text}`);
    }

    const data = await res.json() as OllamaChatResponse;
    return data.message.content;
  }

  /**
   * Streaming chat — yields content deltas as they arrive from Ollama's NDJSON stream.
   * Each yielded value is the incremental token chunk (not cumulative). Concatenate to
   * reconstruct the full message.
   */
  async *chatStream(
    messages: AgentMessage[],
    model: string,
    options: GenerateOptions = {},
  ): AsyncIterable<string> {
    const body: OllamaChatRequest = {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true,
      ...(options.jsonMode ? { format: 'json' } : {}),
      ...(options.temperature !== undefined ? { options: { temperature: options.temperature } } : {}),
    };

    logger.debug({ model, messages: messages.length }, 'Ollama /api/chat (stream)');

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama /api/chat ${res.status}: ${text}`);
    }
    if (!res.body) {
      throw new Error('Ollama /api/chat returned no body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: !done });
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            const chunk = parseChunk(line);
            if (chunk) yield chunk;
          }
          nl = buf.indexOf('\n');
        }
        if (done) {
          const tail = buf.trim();
          if (tail) {
            const chunk = parseChunk(tail);
            if (chunk) yield chunk;
          }
          return;
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  /**
   * Tool-calling chat. Single round-trip — the caller is responsible for the
   * full conversation loop (read response, execute tool calls, append tool
   * results, send again). Non-streaming because tool_call structures are not
   * meaningful until fully formed; partial JSON arguments cannot be executed.
   *
   * Ollama's behaviour: when the model decides to call tools, `message.content`
   * is usually empty and `message.tool_calls` is populated. When the model
   * answers in plain text (no tool needed), `tool_calls` is absent and
   * `content` carries the text.
   */
  async chatWithTools(
    messages: ToolLoopMessage[],
    tools: ToolDefinition[],
    model: string,
    options: GenerateOptions = {},
  ): Promise<ToolCallResponse> {
    const body: OllamaToolChatRequest = {
      model,
      messages: messages.map(m => {
        if (m.role === 'assistant' && m.tool_calls) {
          return { role: m.role, content: m.content, tool_calls: m.tool_calls };
        }
        if (m.role === 'tool') {
          // Some Ollama deployments accept a plain `tool` role; older ones expect
          // it folded into a `user` turn with an explicit prefix. We send the
          // canonical OpenAI-style role and include `tool_name` in content if
          // the runtime needs it for disambiguation.
          return { role: 'tool', content: m.content };
        }
        return { role: m.role, content: m.content };
      }),
      tools,
      stream: false,
      ...(options.temperature !== undefined ? { options: { temperature: options.temperature } } : {}),
    };

    logger.debug({ model, messages: messages.length, tools: tools.length }, 'Ollama /api/chat (tools)');

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama /api/chat (tools) ${res.status}: ${text}`);
    }

    const data = await res.json() as OllamaToolChatResponse;
    const content = data.message.content ?? '';
    const rawToolCalls = data.message.tool_calls;
    let toolCalls = rawToolCalls && rawToolCalls.length > 0
      ? rawToolCalls.map(tc => ({ function: { name: tc.function.name, arguments: tc.function.arguments } }))
      : undefined;

    // Fallback: some Ollama models (notably qwen2.5-coder, gemma2) emit tool
    // calls inline in `content` as JSON objects with shape {"name", "arguments"},
    // instead of populating the structured `tool_calls` field. Detect and
    // recover that pattern so the loop driver can still execute the call.
    if (!toolCalls && content) {
      const extracted = extractInlineToolCalls(content);
      if (extracted.length > 0) {
        logger.debug({ count: extracted.length }, 'Recovered tool calls from message content (model used inline JSON)');
        toolCalls = extracted;
      }
    }

    return { content, toolCalls, model };
  }

  async embed(text: string, model?: string): Promise<number[]> {
    const embedModel = model ?? config.ollama.embedModel;

    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embedModel, prompt: text }),
    });

    if (!res.ok) {
      const raw = await res.text();
      throw new Error(`Ollama /api/embeddings ${res.status}: ${raw}`);
    }

    const data = await res.json() as OllamaEmbedResponse;
    return data.embedding;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

function parseChunk(line: string): string | null {
  try {
    const obj = JSON.parse(line) as Partial<OllamaChatResponse> & { error?: string };
    if (obj.error) throw new Error(`Ollama stream error: ${obj.error}`);
    return obj.message?.content ?? null;
  } catch (err) {
    // Malformed line — log and skip rather than killing the whole stream
    logger.debug({ line, error: String(err) }, 'Skipping malformed Ollama stream chunk');
    return null;
  }
}

/**
 * Extract tool-call objects embedded in a message's `content` string. Some
 * Ollama-served models (qwen2.5-coder, gemma2, occasionally llama3.1) return
 * tool calls as concatenated JSON objects in content, with shape
 * `{"name": "...", "arguments": {...}}`, instead of populating the structured
 * `tool_calls` field. This recovery walks the string with brace-matched JSON
 * extraction and keeps anything that has the expected shape.
 *
 * Robust to: leading/trailing prose, multiple back-to-back calls, embedded
 * strings with `{` and `}` (string-aware brace counter), single call vs many.
 */
function extractInlineToolCalls(
  content: string,
): Array<{ function: { name: string; arguments: Record<string, unknown> } }> {
  const calls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = [];
  let i = 0;
  while (i < content.length) {
    if (content[i] !== '{') { i++; continue; }
    const end = findMatchingBrace(content, i);
    if (end === -1) break;
    const candidate = content.slice(i, end + 1);
    try {
      const obj = JSON.parse(candidate) as Record<string, unknown>;
      const name = obj.name;
      const args = obj.arguments;
      if (
        typeof name === 'string' &&
        name.length > 0 &&
        args !== null &&
        typeof args === 'object' &&
        !Array.isArray(args)
      ) {
        calls.push({
          function: { name, arguments: args as Record<string, unknown> },
        });
      }
    } catch {
      // Not parseable as JSON; skip and look for the next `{`.
    }
    i = end + 1;
  }
  return calls;
}

function findMatchingBrace(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
