import { describe, it, expect } from 'vitest';
import {
  PlanOutputSchema,
} from '../planner.js';
import { CoderOutputSchema } from '../coder.js';
import { ArchitectOutputSchema } from '../architect.js';
import { TesterOutputSchema } from '../tester.js';
import { ReviewerOutputSchema } from '../reviewer.js';
import { FixerOutputSchema } from '../fixer.js';

// ── PlanOutputSchema ─────────────────────────────────────────────────────────

describe('PlanOutputSchema', () => {
  it('accepts a valid plan', () => {
    expect(() =>
      PlanOutputSchema.parse({ steps: [{ id: '1', description: 'foo', dependencies: [] }] })
    ).not.toThrow();
  });

  it('fills missing dependencies with []', () => {
    const result = PlanOutputSchema.parse({ steps: [{ id: '1', description: 'foo' }] });
    expect(result.steps[0].dependencies).toEqual([]);
  });

  it('rejects null steps', () => {
    expect(() => PlanOutputSchema.parse({ steps: null })).toThrow();
  });

  it('rejects empty steps array', () => {
    expect(() => PlanOutputSchema.parse({ steps: [] })).toThrow();
  });

  it('rejects missing description', () => {
    expect(() => PlanOutputSchema.parse({ steps: [{ id: '1' }] })).toThrow();
  });
});

// ── CoderOutputSchema ────────────────────────────────────────────────────────

describe('CoderOutputSchema', () => {
  it('accepts valid file changes', () => {
    expect(() =>
      CoderOutputSchema.parse({
        files: [{ path: 'src/foo.ts', content: 'export {}', action: 'create' }],
      })
    ).not.toThrow();
  });

  it('accepts empty files array', () => {
    expect(() => CoderOutputSchema.parse({ files: [] })).not.toThrow();
  });

  it('rejects invalid action', () => {
    expect(() =>
      CoderOutputSchema.parse({
        files: [{ path: 'src/foo.ts', content: '', action: 'write' }],
      })
    ).toThrow();
  });

  it('rejects empty path', () => {
    expect(() =>
      CoderOutputSchema.parse({
        files: [{ path: '', content: '', action: 'create' }],
      })
    ).toThrow();
  });

  it('rejects missing files field', () => {
    expect(() => CoderOutputSchema.parse({})).toThrow();
  });
});

// ── ArchitectOutputSchema ────────────────────────────────────────────────────

describe('ArchitectOutputSchema', () => {
  it('accepts valid design', () => {
    expect(() => ArchitectOutputSchema.parse({ design: 'Use factory pattern' })).not.toThrow();
  });

  it('rejects empty design string', () => {
    expect(() => ArchitectOutputSchema.parse({ design: '' })).toThrow();
  });

  it('rejects missing design', () => {
    expect(() => ArchitectOutputSchema.parse({})).toThrow();
  });
});

// ── TesterOutputSchema ───────────────────────────────────────────────────────

describe('TesterOutputSchema', () => {
  it('accepts valid test files', () => {
    expect(() =>
      TesterOutputSchema.parse({
        testFiles: [{ path: 'src/__tests__/foo.test.ts', content: 'describe()', action: 'create' }],
      })
    ).not.toThrow();
  });

  it('accepts empty testFiles array', () => {
    expect(() => TesterOutputSchema.parse({ testFiles: [] })).not.toThrow();
  });

  it('rejects missing testFiles field', () => {
    expect(() => TesterOutputSchema.parse({})).toThrow();
  });
});

// ── ReviewerOutputSchema ─────────────────────────────────────────────────────

describe('ReviewerOutputSchema', () => {
  it('accepts approved review', () => {
    expect(() => ReviewerOutputSchema.parse({ isApproved: true, issues: [] })).not.toThrow();
  });

  it('accepts rejected review with issues', () => {
    expect(() =>
      ReviewerOutputSchema.parse({ isApproved: false, issues: ['Missing error handling'] })
    ).not.toThrow();
  });

  it('rejects string isApproved (LLM sends "true" as string)', () => {
    expect(() => ReviewerOutputSchema.parse({ isApproved: 'true', issues: [] })).toThrow();
  });

  it('rejects missing isApproved', () => {
    expect(() => ReviewerOutputSchema.parse({ issues: [] })).toThrow();
  });
});

// ── FixerOutputSchema ────────────────────────────────────────────────────────

describe('FixerOutputSchema', () => {
  it('accepts valid fixed files', () => {
    expect(() =>
      FixerOutputSchema.parse({
        files: [{ path: 'src/foo.ts', content: '// fixed', action: 'modify' }],
      })
    ).not.toThrow();
  });

  it('rejects null files', () => {
    expect(() => FixerOutputSchema.parse({ files: null })).toThrow();
  });
});
