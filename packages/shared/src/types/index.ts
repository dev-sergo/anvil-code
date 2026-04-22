export type ModelRole = 'planner' | 'architect' | 'coder' | 'tester' | 'reviewer' | 'fixer';
export type TaskMode = 'fast' | 'balanced' | 'deep';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface FileChange {
  path: string;
  content: string;
  action: 'create' | 'modify' | 'delete';
}

export interface DiffResult {
  path: string;
  diff: string;
}

export interface TaskDefinition {
  id: string;
  description: string;
  mode: TaskMode;
  createdAt: string;
}
