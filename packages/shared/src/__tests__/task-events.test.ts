import { describe, it, expect, beforeEach, vi } from 'vitest';
import { taskEvents } from '../task-events.js';

describe('taskEvents', () => {
  beforeEach(() => {
    taskEvents.clearHistory('t1');
    taskEvents.clearHistory('t2');
    taskEvents.removeAllListeners('task:t1');
    taskEvents.removeAllListeners('task:t2');
  });

  it('records history per taskId', () => {
    taskEvents.emitEvent({ taskId: 't1', type: 'queued' });
    taskEvents.emitEvent({ taskId: 't1', type: 'running' });
    taskEvents.emitEvent({ taskId: 't2', type: 'queued' });

    const t1 = taskEvents.getHistory('t1');
    expect(t1.map(e => e.type)).toEqual(['queued', 'running']);
    expect(taskEvents.getHistory('t2').map(e => e.type)).toEqual(['queued']);
    for (const e of t1) expect(e.timestamp).toBeGreaterThan(0);
  });

  it('delivers per-task channel events to subscribers', () => {
    const handler = vi.fn();
    taskEvents.on('task:t1', handler);
    taskEvents.emitEvent({ taskId: 't1', type: 'plan', message: 'planned' });
    taskEvents.emitEvent({ taskId: 't2', type: 'plan' }); // different channel
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ taskId: 't1', type: 'plan', message: 'planned' });
  });

  it('isTerminal recognizes done and error', () => {
    expect(taskEvents.isTerminal({ taskId: 'x', type: 'done', timestamp: 0 })).toBe(true);
    expect(taskEvents.isTerminal({ taskId: 'x', type: 'error', timestamp: 0 })).toBe(true);
    expect(taskEvents.isTerminal({ taskId: 'x', type: 'step_start', timestamp: 0 })).toBe(false);
  });

  it('caps history at the per-task limit', () => {
    for (let i = 0; i < 250; i++) {
      taskEvents.emitEvent({ taskId: 't1', type: 'step_start', data: { i } });
    }
    const h = taskEvents.getHistory('t1');
    expect(h.length).toBe(200);
    // Oldest dropped — first remaining event should be index 50
    expect((h[0].data as { i: number }).i).toBe(50);
  });
});
