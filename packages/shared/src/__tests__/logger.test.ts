import { describe, it, expect } from 'vitest';
import { taskLogger, logger } from '../logger.js';

describe('taskLogger', () => {
  it('returns a child logger with taskId in its bindings', () => {
    const log = taskLogger('task-abc');
    // pino exposes the bindings the child was created with
    expect(log.bindings()).toMatchObject({ taskId: 'task-abc' });
  });

  it('inherits the parent logger level', () => {
    const log = taskLogger('task-x');
    expect(log.level).toBe(logger.level);
  });

  it('separate child loggers have independent taskIds', () => {
    const a = taskLogger('a');
    const b = taskLogger('b');
    expect(a.bindings().taskId).toBe('a');
    expect(b.bindings().taskId).toBe('b');
  });
});
