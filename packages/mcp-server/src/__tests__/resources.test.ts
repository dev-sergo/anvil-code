import { describe, it, expect } from 'vitest';
import {
  buildAdrRecentText,
  buildAdrByIdText,
  buildFailuresTopText,
  buildTasksRecentText,
  formatAdr,
} from '../resources.js';

const adr = {
  id: 'adr-1',
  taskId: 't-1',
  decision: 'Use HNSW for vector search',
  context: 'Need fast nearest-neighbor over thousands of code embeddings.',
  consequences: 'Native binding adds build step but performance is acceptable.',
  createdAt: '2026-04-22 10:00:00',
};

describe('resources/adr', () => {
  it('formatAdr renders all fields', () => {
    const md = formatAdr(adr);
    expect(md).toContain('## Use HNSW for vector search');
    expect(md).toContain('task t-1');
    expect(md).toContain('Need fast nearest-neighbor');
    expect(md).toContain('Native binding adds build step');
  });

  it('buildAdrRecentText handles empty store', () => {
    const text = buildAdrRecentText({ listADR: () => [] });
    expect(text).toMatch(/No architectural decisions/);
  });

  it('buildAdrRecentText concatenates ADRs with separator', () => {
    const text = buildAdrRecentText({ listADR: () => [adr, { ...adr, id: 'adr-2', decision: 'Pin Node 22' }] });
    expect(text).toContain('Recent Architectural Decisions (2)');
    expect(text).toContain('Use HNSW for vector search');
    expect(text).toContain('Pin Node 22');
    expect(text).toContain('---');
  });

  it('buildAdrByIdText returns null when not found', () => {
    expect(buildAdrByIdText({ listADR: () => [adr] }, 'missing')).toBeNull();
  });

  it('buildAdrByIdText returns formatted ADR when found', () => {
    const out = buildAdrByIdText({ listADR: () => [adr] }, 'adr-1');
    expect(out).not.toBeNull();
    expect(out!).toContain('Use HNSW for vector search');
  });
});

describe('resources/failures', () => {
  it('handles empty failures', () => {
    expect(buildFailuresTopText({ getFailurePatterns: () => [] })).toMatch(/system has been healthy/);
  });

  it('formats counts and resolutions', () => {
    const text = buildFailuresTopText({
      getFailurePatterns: () => [
        { pattern: 'step-failure:plan:Cannot read', count: 3, resolution: 'Tighten Zod schema' },
        { pattern: 'validation-failure:tsc', count: 1 },
      ],
    });
    expect(text).toContain('×3');
    expect(text).toContain('Tighten Zod schema');
    expect(text).toContain('validation-failure:tsc');
  });
});

describe('resources/tasks', () => {
  it('handles empty tasks list', () => {
    expect(buildTasksRecentText({ listTasks: () => [] })).toMatch(/No tasks/);
  });

  it('truncates long descriptions and includes results', () => {
    const long = 'a'.repeat(150);
    const text = buildTasksRecentText({
      listTasks: () => [
        { id: 't-1', description: long, status: 'completed', result: 'Completed 3/3 steps' },
        { id: 't-2', description: 'short', status: 'failed' },
      ],
    });
    expect(text).toContain('completed');
    expect(text).toContain('failed');
    expect(text).toContain('Completed 3/3 steps');
    expect(text).toMatch(/a{80}…/);
  });
});
