import { describe, it, expect } from 'vitest';
import { withTaskContext, withAgent, currentTaskContext } from '../task-context.js';

describe('task-context (AsyncLocalStorage)', () => {
  it('returns undefined outside a withTaskContext scope', () => {
    expect(currentTaskContext()).toBeUndefined();
  });

  it('exposes the context inside the scope', async () => {
    const got = await withTaskContext({ taskId: 't-1', stepId: 's-a' }, async () => {
      return currentTaskContext();
    });
    expect(got).toEqual({ taskId: 't-1', stepId: 's-a' });
  });

  it('propagates through async boundaries', async () => {
    await withTaskContext({ taskId: 't-2' }, async () => {
      await new Promise(r => setTimeout(r, 10));
      expect(currentTaskContext()?.taskId).toBe('t-2');
      await Promise.all([
        Promise.resolve().then(() => expect(currentTaskContext()?.taskId).toBe('t-2')),
        Promise.resolve().then(() => expect(currentTaskContext()?.taskId).toBe('t-2')),
      ]);
    });
  });

  it('isolates concurrent contexts', async () => {
    const observed: string[] = [];
    await Promise.all([
      withTaskContext({ taskId: 'a' }, async () => {
        await new Promise(r => setTimeout(r, 5));
        observed.push(currentTaskContext()!.taskId);
      }),
      withTaskContext({ taskId: 'b' }, async () => {
        await new Promise(r => setTimeout(r, 5));
        observed.push(currentTaskContext()!.taskId);
      }),
    ]);
    expect(observed.sort()).toEqual(['a', 'b']);
  });

  it('withAgent overrides agent while keeping taskId', async () => {
    await withTaskContext({ taskId: 't-3' }, async () => {
      const inner = await withAgent('Coder', () => currentTaskContext());
      expect(inner).toEqual({ taskId: 't-3', agent: 'Coder' });
      // Outer scope unchanged
      expect(currentTaskContext()).toEqual({ taskId: 't-3' });
    });
  });

  it('withAgent is a no-op when called outside a task scope', async () => {
    const got = await withAgent('Coder', () => currentTaskContext());
    expect(got).toBeUndefined();
  });
});
