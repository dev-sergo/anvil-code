import { randomUUID } from 'crypto';
import type { TaskMode } from '@rag-system/shared';

export interface Job {
  id: string;
  projectId: string;
  description: string;
  mode: TaskMode;
  status: 'queued' | 'running' | 'completed' | 'failed';
  priority: number;
  createdAt: number;
  error?: string;
}

export class MemoryQueue {
  private jobs: Map<string, Job> = new Map();

  enqueue(projectId: string, description: string, mode: TaskMode, priority = 0): Job {
    const job: Job = {
      id: randomUUID(),
      projectId,
      description,
      mode,
      status: 'queued',
      priority,
      createdAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  dequeue(): Job | undefined {
    const queued = [...this.jobs.values()]
      .filter(j => j.status === 'queued')
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    const job = queued[0];
    if (!job) return undefined;
    job.status = 'running';
    return job;
  }

  updateStatus(id: string, status: Job['status'], error?: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.status = status;
      if (error) job.error = error;
    }
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  getAll(): Job[] {
    return [...this.jobs.values()];
  }
}
