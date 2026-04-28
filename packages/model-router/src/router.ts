import { config } from '@rag-system/shared';
import type { ModelRole } from '@rag-system/shared';
import { OllamaClient } from './ollama-client.js';
import type {
  RouteRequest,
  RouteResponse,
  ToolCallResponse,
  ToolDefinition,
  ToolLoopMessage,
  GenerateOptions,
} from './types.js';

const ROLE_SIZE: Record<ModelRole, 'small' | 'large'> = {
  planner: 'small',
  reviewer: 'small',
  tester: 'small',
  architect: 'large',
  coder: 'large',
  fixer: 'large',
};

export class ModelRouter {
  private client: OllamaClient;
  private modelLarge: string;
  private modelSmall: string;

  constructor(client?: OllamaClient) {
    this.client = client ?? new OllamaClient();
    this.modelLarge = config.ollama.modelLarge;
    this.modelSmall = config.ollama.modelSmall;
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
