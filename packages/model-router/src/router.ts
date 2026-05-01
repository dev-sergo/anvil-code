import { config } from '@rag-system/shared';
import type { ModelRole } from '@rag-system/shared';
import type {
  RouteRequest,
  RouteResponse,
  ToolCallResponse,
  ToolDefinition,
  ToolLoopMessage,
  GenerateOptions,
} from './types.js';
import type { ModelBackend } from './backend.js';
import { createChatBackend } from './backend.js';

/**
 * Role → size class. Drives default model selection in `selectModel`. taskMode
 * 'fast' / 'deep' overrides this. Same mapping for both backends — sizes are
 * conceptual, not bound to a specific model name.
 */
const ROLE_SIZE: Record<ModelRole, 'small' | 'large'> = {
  planner: 'small',
  reviewer: 'small',
  tester: 'small',
  architect: 'large',
  coder: 'large',
  fixer: 'large',
};

export class ModelRouter {
  private client: ModelBackend;
  private modelLarge: string;
  private modelSmall: string;

  /**
   * Construct with an explicit backend (used in tests) or rely on the env-driven
   * factory. Model name selection always follows `config.llmBackend` — passing a
   * client only overrides the transport, not the model namespace.
   */
  constructor(client?: ModelBackend) {
    this.client = client ?? createChatBackend();
    if (config.llmBackend === 'llamacpp') {
      this.modelLarge = config.llamacpp.modelLarge;
      this.modelSmall = config.llamacpp.modelSmall;
    } else {
      this.modelLarge = config.ollama.modelLarge;
      this.modelSmall = config.ollama.modelSmall;
    }
  }

  private selectModel(role: ModelRole, taskMode?: string): string {
    if (taskMode === 'fast') return this.modelSmall;
    if (taskMode === 'deep') return this.modelLarge;
    return ROLE_SIZE[role] === 'large' ? this.modelLarge : this.modelSmall;
  }

  async route(request: RouteRequest): Promise<RouteResponse> {
    const model = this.selectModel(request.role, request.taskMode);
    const content = await this.client.chat(request.messages, model, request.options);
    return { content, model, role: request.role };
  }

  /**
   * Streaming variant — yields content deltas. Caller is responsible for accumulating
   * the full response if it needs the complete string.
   */
  async *routeStream(request: RouteRequest): AsyncIterable<{ chunk: string; model: string; role: ModelRole }> {
    const model = this.selectModel(request.role, request.taskMode);
    for await (const chunk of this.client.chatStream(request.messages, model, request.options ?? {})) {
      yield { chunk, model, role: request.role };
    }
  }

  /**
   * One round of tool-calling chat. Caller drives the loop (executes tools,
   * appends results, calls again). Selects the model the same way as
   * `route()` so tool-calling agents inherit role-based sizing automatically.
   */
  async routeWithTools(
    role: ModelRole,
    messages: ToolLoopMessage[],
    tools: ToolDefinition[],
    taskMode?: 'fast' | 'balanced' | 'deep',
    options: GenerateOptions = {},
  ): Promise<ToolCallResponse> {
    const model = this.selectModel(role, taskMode);
    return this.client.chatWithTools(messages, tools, model, options);
  }
}
