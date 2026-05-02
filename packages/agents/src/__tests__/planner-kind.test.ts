import { describe, it, expect } from 'vitest';
import { PlanStepSchema, PlanOutputSchema, inferStepKind } from '../planner.js';

describe('PlanStepSchema — kind field (v1.32-c)', () => {
  it('parses with explicit kind="bugfix"', () => {
    const parsed = PlanStepSchema.parse({
      id: 'step1',
      description: 'Fix createdAt missing',
      dependencies: [],
      kind: 'bugfix',
    });
    expect(parsed.kind).toBe('bugfix');
  });

  it('defaults kind to "feature" when missing (BC for old planner outputs)', () => {
    const parsed = PlanStepSchema.parse({
      id: 'step1',
      description: 'Add /version endpoint',
      dependencies: [],
    });
    expect(parsed.kind).toBe('feature');
  });

  it('rejects invalid kind values', () => {
    expect(() => PlanStepSchema.parse({
      id: 'step1', description: 'x', dependencies: [], kind: 'unknown',
    })).toThrow();
  });

  it('PlanOutputSchema accepts steps with mixed kinds', () => {
    const parsed = PlanOutputSchema.parse({
      steps: [
        { id: 'a', description: 'add X', dependencies: [], kind: 'feature' },
        { id: 'b', description: 'rename Y', dependencies: [], kind: 'refactor' },
        { id: 'c', description: 'fix Z', dependencies: [], kind: 'bugfix' },
      ],
    });
    expect(parsed.steps.map(s => s.kind)).toEqual(['feature', 'refactor', 'bugfix']);
  });
});

describe('inferStepKind — heuristic classifier', () => {
  it.each([
    ['Fix the createdAt missing in user response', 'bugfix'],
    ['The /version endpoint is broken — returns 404', 'bugfix'],
    ['Tests fail with TypeError on UserService.create', 'bugfix'],
    ['UserService forgets to set updatedAt', 'bugfix'],
  ] as const)('classifies %s → bugfix', (desc, kind) => {
    expect(inferStepKind(desc)).toBe(kind);
  });

  it.each([
    ['Refactor UserService to extract validation helper', 'refactor'],
    ['Rename getCwd to getCurrentWorkingDirectory across the project', 'refactor'],
    ['Convert the const-object-literal config into a class', 'refactor'],
    ['Migrate the shared types from packages/shared to packages/types', 'refactor'],
  ] as const)('classifies %s → refactor', (desc, kind) => {
    expect(inferStepKind(desc)).toBe(kind);
  });

  it.each([
    ['Add a /version endpoint that returns { version: "1.0.0" }', 'feature'],
    ['Implement soft-delete on the users resource', 'feature'],
    ['Create src/middleware/request-id.ts and register it', 'feature'],
  ] as const)('classifies %s → feature', (desc, kind) => {
    expect(inferStepKind(desc)).toBe(kind);
  });

  it('case-insensitive: uppercase keywords still classify correctly', () => {
    expect(inferStepKind('FIX the bug in foo.ts')).toBe('bugfix');
    expect(inferStepKind('REFACTOR the user module')).toBe('refactor');
  });

  it('does not over-match: "addition" is feature, not bugfix or refactor', () => {
    expect(inferStepKind('Add an addition operation to Calculator')).toBe('feature');
  });
});
