import { AsyncLocalStorage } from 'async_hooks';

export interface TaskContext {
  taskId: string;
  stepId?: string;
  agent?: string;
}

const storage = new AsyncLocalStorage<TaskContext>();

/** Run `fn` with `ctx` available to all async descendants via `currentTaskContext()`. */
export function withTaskContext<T>(ctx: TaskContext, fn: () => T | Promise<T>): T | Promise<T> {
  return storage.run(ctx, fn);
}

/** The active task context, if any (returns undefined outside a `withTaskContext` scope). */
export function currentTaskContext(): TaskContext | undefined {
  return storage.getStore();
}

/** Convenience: derive a child context that overrides `agent` while keeping the task/step. */
export function withAgent<T>(agent: string, fn: () => T | Promise<T>): T | Promise<T> {
  const parent = storage.getStore();
  if (!parent) return fn();
  return storage.run({ ...parent, agent }, fn);
}
