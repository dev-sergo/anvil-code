export interface TaskRecord {
  id: string;
  description: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  result?: string;
  completedAt?: string;
  createdAt?: string;
}

export interface ADRRecord {
  id: string;
  taskId: string;
  decision: string;
  context: string;
  consequences: string;
  createdAt?: string;
}

export interface FailureRecord {
  id?: number;
  pattern: string;
  count: number;
  resolution?: string;
  lastSeenAt?: string;
}

export interface RepoPatternRecord {
  id: string;
  issue: string;
  projectId: string;
  hitCount: number;
  issueHash?: string;
  /** Set at runtime during merge; not stored in DB. */
  isLocal?: boolean;
  createdAt?: string;
  lastSeen?: string;
}
