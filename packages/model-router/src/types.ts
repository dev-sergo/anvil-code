import type { AgentMessage, ModelRole, TaskMode } from '@rag-system/shared';

export interface RouteRequest {
  role: ModelRole;
  messages: AgentMessage[];
  taskMode?: TaskMode;
  options?: GenerateOptions;
}

export interface RouteResponse {
  content: string;
  model: string;
  role: ModelRole;
}

export interface GenerateOptions {
  jsonMode?: boolean;
  temperature?: number;
}

/**
 * OpenAI-compatible function/tool schema. Ollama accepts this shape on the
 * `tools` field of /api/chat for models that support tool calling (qwen2.5-coder,
 * llama3.1+, gemma2 with grammar etc.). Parameters use JSON Schema.
 */
/**
 * JSON-Schema property descriptor. Recursive on `items` so array properties
 * can declare their element shape (`{ type: 'array', items: { type: 'string' }}`).
 * Ollama and OpenAI both accept this shape on tool parameter properties.
 */
export interface ToolParamSchema {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolParamSchema;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, ToolParamSchema>;
      required?: string[];
    };
  };
}

/**
 * One tool call emitted by the model. `arguments` arrives parsed (Ollama
 * returns it as a structured object, unlike OpenAI which returns a JSON string).
 */
export interface ToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/**
 * One assistant turn that may include tool calls. When the model decides to
 * answer in plain text (no tools), `tool_calls` is undefined or empty.
 */
export interface ToolCallResponse {
  content: string;
  toolCalls?: ToolCall[];
  model: string;
}

/**
 * Conversation messages augmented with tool roles. Used for the multi-turn
 * tool-calling loop: assistant emits tool calls, runtime executes them and
 * feeds results back as `role: 'tool'` messages, then asks the model again.
 */
export type ToolLoopMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_name?: string };
