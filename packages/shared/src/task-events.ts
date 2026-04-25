import { EventEmitter } from 'events';

export type TaskEventType =
  | 'queued'
  | 'running'
  | 'plan'
  | 'step_start'
  | 'step_complete'
  | 'step_fail'
  | 'step_skip'
  | 'agent_stream'
  | 'coder_file_ready'
  | 'validation_start'
  | 'validation_pass'
  | 'validation_fail'
  | 'commit'
  | 'commit_skipped'
  | 'done'
  | 'error'
  // Indexing pipeline events. The "taskId" carries an indexId of the form
  // `idx-<timestamp>` so SSE clients can subscribe to a specific indexing run
  // via the same /task/:id/stream endpoint.
  | 'index_start'
  | 'index_file'
  | 'index_skip'
  | 'index_done';

export interface TaskEvent {
  taskId: string;
  type: TaskEventType;
  timestamp: number;
  message?: string;
  data?: Record<string, unknown>;
}

const HISTORY_LIMIT = 200;

// High-frequency event types skip the history buffer — they're for live consumers only.
// Replaying agent token streams or per-file index ticks to late-joining SSE clients
// would be useless noise; the start/done events stay in history for context.
const TRANSIENT_EVENTS = new Set<TaskEventType>(['agent_stream', 'index_file', 'index_skip']);

class TaskEventBus extends EventEmitter {
  private history = new Map<string, TaskEvent[]>();

  emitEvent(event: Omit<TaskEvent, 'timestamp'>): void {
    const full: TaskEvent = { ...event, timestamp: Date.now() };
    if (!TRANSIENT_EVENTS.has(full.type)) {
      const buf = this.history.get(full.taskId) ?? [];
      buf.push(full);
      if (buf.length > HISTORY_LIMIT) buf.shift();
      this.history.set(full.taskId, buf);
    }
    this.emit('event', full);
    this.emit(`task:${full.taskId}`, full);
  }

  getHistory(taskId: string): TaskEvent[] {
    return this.history.get(taskId) ?? [];
  }

  clearHistory(taskId: string): void {
    this.history.delete(taskId);
  }

  isTerminal(event: TaskEvent): boolean {
    return event.type === 'done' || event.type === 'error';
  }
}

export const taskEvents = new TaskEventBus();
// Many SSE clients can subscribe; raise the cap.
taskEvents.setMaxListeners(0);
