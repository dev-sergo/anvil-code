import type { TaskEvent } from '@rag-system/shared';

export interface Project {
  id: string;
  name: string;
  root: string;
  createdAt: number;
  lastAccessedAt: number;
}

export interface TaskRecord {
  id: string;
  description: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  result?: string;
  createdAt?: string;
  completedAt?: string;
}

export interface ApiHealth {
  status: string;
  ollama: boolean;
  uptime: number;
}

/**
 * Thin HTTP wrapper over the RAG API. All methods throw on non-2xx with the
 * server's error message attached so callers can surface it in vscode notices.
 */
export class RagApiClient {
  constructor(public baseUrl: string) {}

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, '');
  }

  async health(): Promise<ApiHealth> {
    return this.req('GET', '/health');
  }

  async listProjects(): Promise<Project[]> {
    const r = await this.req<{ projects: Project[] }>('GET', '/projects');
    return r.projects;
  }

  async registerProject(root: string, name?: string): Promise<Project> {
    return this.req('POST', '/project', { root, name });
  }

  async listTasks(projectId?: string): Promise<TaskRecord[]> {
    const query = projectId ? `?project=${encodeURIComponent(projectId)}` : '';
    const r = await this.req<{ tasks: TaskRecord[] }>('GET', `/tasks${query}`);
    return r.tasks;
  }

  async createTask(opts: {
    task: string;
    mode?: 'fast' | 'balanced' | 'deep';
    project?: string;
  }): Promise<{ task_id: string; project_id: string; status: string }> {
    return this.req('POST', '/task', opts);
  }

  async indexProject(projectId?: string, root?: string): Promise<{ index_id: string; project_id: string; root: string }> {
    return this.req('POST', '/index', { project: projectId, root });
  }

  /** SSE — returns an AsyncIterable so callers can `for await` and dispose by breaking out. */
  async *streamTask(taskId: string, signal?: AbortSignal): AsyncIterable<TaskEvent> {
    const res = await fetch(`${this.baseUrl}/task/${encodeURIComponent(taskId)}/stream`, { signal });
    if (!res.ok) throw new Error(`SSE failed: ${res.status} ${await res.text()}`);
    if (!res.body) throw new Error('SSE returned no body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: !done });

        // SSE frames are separated by a blank line (\n\n)
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const event = parseSseFrame(frame);
          if (event) yield event;
          sep = buf.indexOf('\n\n');
        }

        if (done) return;
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  private async req<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} failed: ${res.status} ${text}`);
    }
    return await res.json() as T;
  }
}

/** Parse a single SSE frame ("event: X\ndata: {...}") into a TaskEvent. */
export function parseSseFrame(frame: string): TaskEvent | null {
  const lines = frame.split('\n');
  let dataLine: string | null = null;
  for (const line of lines) {
    if (line.startsWith(':')) continue;          // comments / heartbeat
    if (line.startsWith('data:')) dataLine = line.slice(5).trim();
  }
  if (!dataLine) return null;
  try {
    return JSON.parse(dataLine) as TaskEvent;
  } catch {
    return null;
  }
}
