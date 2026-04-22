import { config, logger } from '@rag-system/shared';
import type { AgentMessage } from '@rag-system/shared';
import type { GenerateOptions } from './types.js';

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
