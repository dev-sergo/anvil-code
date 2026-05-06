import { config } from '@rag-system/shared';
import type { AgentMessage } from '@rag-system/shared';
import type { GenerateOptions, ToolCallResponse, ToolDefinition, ToolLoopMessage } from './types.js';
import { OllamaClient } from './ollama-client.js';
import { LlamaSwapClient } from './llamaswap-client.js';

export interface RerankResult {
  index: number;
  relevanceScore: number;
}

/**
 * Common chat-completion + embedding contract that both backends implement.
 * v1.32-d introduces this seam so `ModelRouter` can dispatch to either Ollama
 * or llama-swap (via OpenAI-compatible API) without callers caring which one.
 *
 * Method semantics mirror the existing OllamaClient surface 1:1 — adding a
 * new backend means subclassing this contract; agents/router code stays put.
 */
export interface ModelBackend {
  /** One-shot chat completion. Returns the full assistant message content. */
  chat(messages: AgentMessage[], model: string, options?: GenerateOptions): Promise<string>;

  /**
   * Streaming chat. Yields content deltas as they arrive (not cumulative —
   * concatenate to reconstruct the full response).
   */
  chatStream(messages: AgentMessage[], model: string, options?: GenerateOptions): AsyncIterable<string>;

  /**
   * Single round of tool-calling chat. Caller drives the loop (executes tool
   * calls, appends results, calls again). Non-streaming because partial JSON
   * tool-call arguments are not safely executable.
   */
  chatWithTools(
    messages: ToolLoopMessage[],
    tools: ToolDefinition[],
    model: string,
    options?: GenerateOptions,
  ): Promise<ToolCallResponse>;

  /** Compute a single text embedding. Returns the embedding vector. */
  embed(text: string, model?: string): Promise<number[]>;

  /**
   * Re-rank documents against a query. Returns results sorted DESC by relevance score.
   * Optional — only LlamaSwapClient implements this; Ollama path leaves it undefined.
   * Callers must guard with `backend.rerank?.(...)`.
   */
  rerank?(query: string, documents: string[], model?: string): Promise<RerankResult[]>;

  /** Returns true if the backend is reachable (typically a `/health` ping with timeout). */
  healthCheck(): Promise<boolean>;
}

/**
 * Construct the chat backend implied by `config.llmBackend`. Caller can pass an
 * explicit override (used in tests). Throws on unknown values — ValidateConfig
 * also catches this at startup.
 */
export function createChatBackend(override?: ModelBackend): ModelBackend {
  if (override) return override;
  switch (config.llmBackend) {
    case 'llamacpp': return new LlamaSwapClient(config.llamacpp.url);
    case 'ollama':   return new OllamaClient(config.ollama.baseUrl);
    default:         throw new Error(`Unknown llmBackend: "${String(config.llmBackend)}"`);
  }
}

/**
 * Construct the embed backend. By default mirrors `llmBackend`; the
 * `EMBED_BACKEND` env var allows hybrid mode (e.g. chat→llama-swap,
 * embed→Ollama) for the rare case the embedding model is only available on
 * one of the backends.
 */
export function createEmbedBackend(override?: ModelBackend): ModelBackend {
  if (override) return override;
  const kind = effectiveEmbedBackendKind();
  switch (kind) {
    case 'llamacpp': return new LlamaSwapClient(config.llamacpp.url);
    case 'ollama':   return new OllamaClient(config.ollama.baseUrl);
    default:         throw new Error(`Unknown embedBackend: "${String(kind)}"`);
  }
}

/**
 * Resolve the active embed backend kind (factoring in the `EMBED_BACKEND`
 * hybrid override). Used by callers that need to know which model name to
 * pass — e.g. cache keys must vary by model so an Ollama-built cache is not
 * reused after switching to llama-swap.
 */
export function effectiveEmbedBackendKind(): 'ollama' | 'llamacpp' {
  return config.embedBackend === '' ? config.llmBackend : config.embedBackend;
}

/**
 * Resolve the embed model name for the active backend. Returns the alias
 * (`'embed'` for llama-swap) or the Ollama model id (`'nomic-embed-text'`),
 * whichever the active backend will actually invoke.
 */
export function effectiveEmbedModel(): string {
  return effectiveEmbedBackendKind() === 'llamacpp'
    ? config.llamacpp.modelEmbed
    : config.ollama.embedModel;
}
