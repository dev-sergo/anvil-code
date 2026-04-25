import { describe, it, expect } from 'vitest';
import { formatEventLine, taskLabel, taskStatusIcon, taskTooltip, projectLabel } from '../format.js';
import type { TaskEvent } from '@rag-system/shared';

const ts = 1700000000000;

describe('formatEventLine', () => {
  it('formats every known event type into a single readable line', () => {
    const events: TaskEvent[] = [
      { taskId: 't', type: 'queued', timestamp: ts, message: 'Task queued' },
      { taskId: 't', type: 'running', timestamp: ts, message: 'Job started' },
      { taskId: 't', type: 'plan', timestamp: ts, data: { stepCount: 3, stepIds: ['s1','s2','s3'] } },
      { taskId: 't', type: 'step_start', timestamp: ts, message: 'Step s1: do thing' },
      { taskId: 't', type: 'step_complete', timestamp: ts, data: { stepId: 's1', fileCount: 2 } },
      { taskId: 't', type: 'step_fail', timestamp: ts, data: { stepId: 's2', error: 'oops' } },
      { taskId: 't', type: 'step_skip', timestamp: ts, data: { stepId: 's3', blockedBy: ['s2'] } },
      { taskId: 't', type: 'agent_stream', timestamp: ts, data: { agent: 'Coder', chunk: 'hello world', totalLen: 11 } },
      { taskId: 't', type: 'coder_file_ready', timestamp: ts, data: { path: 'src/x.ts', action: 'create', size: 42 } },
      { taskId: 't', type: 'validation_start', timestamp: ts, message: 'Running typecheck' },
      { taskId: 't', type: 'validation_pass', timestamp: ts, message: 'OK' },
      { taskId: 't', type: 'validation_fail', timestamp: ts, message: 'tsc errors' },
      { taskId: 't', type: 'commit', timestamp: ts, message: 'Committed 3 file(s)' },
      { taskId: 't', type: 'done', timestamp: ts, message: 'Task done' },
      { taskId: 't', type: 'error', timestamp: ts, message: 'crashed' },
      { taskId: 'idx', type: 'index_start', timestamp: ts, data: { totalFiles: 5, root: '/a' } },
      { taskId: 'idx', type: 'index_file', timestamp: ts, data: { processed: 3, totalFiles: 5, percent: 60, file: 'a.ts' } },
      { taskId: 'idx', type: 'index_skip', timestamp: ts, data: { processed: 1, totalFiles: 5, percent: 20, file: 'b.ts' } },
      { taskId: 'idx', type: 'index_done', timestamp: ts, data: { indexed: 4, skipped: 1, vectors: 47, durationMs: 234 } },
    ];
    for (const e of events) {
      const line = formatEventLine(e);
      expect(line.length).toBeGreaterThan(10);
      // Every line begins with a [HH:MM:SS.mmm] timestamp prefix
      expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]/);
    }
  });

  it('truncates verbose agent_stream chunks but reports their length', () => {
    const longChunk = 'x'.repeat(500);
    const line = formatEventLine({
      taskId: 't', type: 'agent_stream', timestamp: ts,
      data: { agent: 'Coder', chunk: longChunk, totalLen: 500 },
    });
    expect(line).toContain('+500b');
    expect(line).toContain('total=500b');
    // The preview is hard-capped well below the full chunk
    expect(line.length).toBeLessThan(150);
  });

  it('falls back to a generic line for unknown event types', () => {
    // @ts-expect-error — exercising the default branch
    const line = formatEventLine({ taskId: 't', type: 'mystery', timestamp: ts, message: 'huh' });
    expect(line).toContain('MYSTERY');
    expect(line).toContain('huh');
  });
});

describe('task formatters', () => {
  it('truncates long task descriptions', () => {
    const t = { id: 'id', description: 'a'.repeat(120), status: 'queued' as const };
    expect(taskLabel(t)).toMatch(/^a{60}…$/);
  });

  it('returns a codicon name per status', () => {
    expect(taskStatusIcon('queued')).toBe('clock');
    expect(taskStatusIcon('running')).toBe('sync~spin');
    expect(taskStatusIcon('completed')).toBe('check');
    expect(taskStatusIcon('failed')).toBe('error');
  });

  it('tooltip includes id, status, description, result, timestamps', () => {
    const md = taskTooltip({
      id: 'tsk-1', description: 'do it', status: 'completed',
      result: 'all good', createdAt: '2026-04-01', completedAt: '2026-04-02',
    });
    expect(md).toContain('tsk-1');
    expect(md).toContain('completed');
    expect(md).toContain('do it');
    expect(md).toContain('all good');
    expect(md).toContain('2026-04-01');
    expect(md).toContain('2026-04-02');
  });

  it('projectLabel marks the active project with a star', () => {
    const p = { id: 'p1', name: 'Foo', root: '/x', createdAt: 0, lastAccessedAt: 0 };
    expect(projectLabel(p, true)).toBe('★ Foo');
    expect(projectLabel(p, false)).toBe('Foo');
  });
});
