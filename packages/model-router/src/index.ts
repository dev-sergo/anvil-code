export { OllamaClient } from './ollama-client.js';
export { LlamaSwapClient } from './llamaswap-client.js';
export { ModelRouter } from './router.js';
export { createChatBackend, createEmbedBackend, effectiveEmbedBackendKind, effectiveEmbedModel } from './backend.js';
export type { ModelBackend } from './backend.js';
export type {
  RouteRequest,
  RouteResponse,
  GenerateOptions,
  ToolDefinition,
  ToolCall,
  ToolCallResponse,
  ToolLoopMessage,
} from './types.js';
