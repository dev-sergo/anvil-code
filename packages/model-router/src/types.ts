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
