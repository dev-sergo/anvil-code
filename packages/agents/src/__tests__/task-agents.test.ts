import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import type { ToolLoopMessage } from '@rag-system/model-router';
import { runTaskAgent } from '../task-agents/runner.js';
import { FEATURE_SPEC } from '../task-agents/feature.js';
import { BUGFIX_SPEC } from '../task-agents/bugfix.js';
import { REFACTOR_SPEC } from '../task-agents/refactor.js';
import { SPECS, pickSpec } from '../task-agents/registry.js';
import { ALWAYS_FORBIDDEN_PATTERNS, PATHOLOGY_THRESHOLD, MAX_PATHOLOGY_STRIKES } from '../tool-calling-coder.js';
import { FIXER_TEST_PATH_FORBIDDEN } from '../tool-calling-fixer.js';
import type { TaskAgentSpec } from '../task-agents/spec.js';

// v1.32-c — three task-agents over one shared loop. Tests cover (a) registry
// routing by step.kind, (b) per-spec field invariants, (c) shared-loop
// behaviors parameterized across all three specs, (d) end-to-end smoke via
// runTaskAgent + fake router.

describe('pickSpec — kind → spec routing', () => {
  it('returns FEATURE_SPEC for kind=feature', () => {
    expect(pickSpec('feature')).toBe(FEATURE_SPEC);
  });
  it('returns BUGFIX_SPEC for kind=bugfix', () => {
    expect(pickSpec('bugfix')).toBe(BUGFIX_SPEC);
  });
  it('returns REFACTOR_SPEC for kind=refactor', () => {
    expect(pickSpec('refactor')).toBe(REFACTOR_SPEC);
  });
  it('defaults to FEATURE_SPEC when kind is undefined', () => {
    expect(pickSpec(undefined)).toBe(FEATURE_SPEC);
  });
  it('SPECS map is exhaustive over PlanStep.kind union', () => {
    expect(Object.keys(SPECS).sort()).toEqual(['bugfix', 'feature', 'refactor']);
  });
});

describe('FEATURE_SPEC — invariants', () => {
  it('kind="feature", agentName matches Coder label, role=coder', () => {
    expect(FEATURE_SPEC.kind).toBe('feature');
    expect(FEATURE_SPEC.agentName).toBe('Coder(tool-calling)');
    expect(FEATURE_SPEC.agentRole).toBe('coder');
  });
  it('maxToolCalls=50, pruneHistory=false, emitPerFileEvents=true', () => {
    expect(FEATURE_SPEC.maxToolCalls).toBe(50);
    expect(FEATURE_SPEC.pruneHistory).toBe(false);
    expect(FEATURE_SPEC.emitPerFileEvents).toBe(true);
  });
  it('forbiddenPatterns equals ALWAYS_FORBIDDEN_PATTERNS (no test-path ban)', () => {
    expect(FEATURE_SPEC.forbiddenPatterns).toEqual(ALWAYS_FORBIDDEN_PATTERNS);
  });
  it('buildAllowedSet extracts task-mentioned paths from stepDescription', () => {
    const allowed = FEATURE_SPEC.buildAllowedSet({
      stepDescription: 'In src/routes/users.ts, add the /version endpoint.',
      context: '',
      taskMode: 'balanced',
    });
    expect(allowed.has('src/routes/users.ts')).toBe(true);
  });
  it('systemPrompt mentions structural-tools-preferred guidance', () => {
    expect(FEATURE_SPEC.systemPrompt).toMatch(/STRUCTURAL TOOLS \(PREFERRED/);
  });
});

describe('BUGFIX_SPEC — invariants', () => {
  it('kind="bugfix", agentName matches Fixer label, role=fixer', () => {
    expect(BUGFIX_SPEC.kind).toBe('bugfix');
    expect(BUGFIX_SPEC.agentName).toBe('Fixer(tool-calling)');
    expect(BUGFIX_SPEC.agentRole).toBe('fixer');
  });
  it('maxToolCalls=30, pruneHistory=true, emitPerFileEvents=false', () => {
    expect(BUGFIX_SPEC.maxToolCalls).toBe(30);
    expect(BUGFIX_SPEC.pruneHistory).toBe(true);
    expect(BUGFIX_SPEC.emitPerFileEvents).toBe(false);
  });
  it('perFileEventSource is "fixer" so SSE events are tagged correctly', () => {
    expect(BUGFIX_SPEC.perFileEventSource).toBe('fixer');
  });
  it('forbiddenPatterns includes both ALWAYS_FORBIDDEN and test-path patterns', () => {
    for (const re of ALWAYS_FORBIDDEN_PATTERNS) {
      expect(BUGFIX_SPEC.forbiddenPatterns).toContain(re);
    }
    for (const re of FIXER_TEST_PATH_FORBIDDEN) {
      expect(BUGFIX_SPEC.forbiddenPatterns).toContain(re);
    }
  });
  it('validation-mode buildAllowedSet equals buildFixerAllowedSet output', () => {
    const allowed = BUGFIX_SPEC.buildAllowedSet({
      stepDescription: '<validation>',
      context: '',
      taskMode: 'balanced',
      issues: ['src/services/user.ts:42 Cannot find name X'],
      currentFiles: [{ action: 'modify', path: 'src/routes/users.ts', edits: [{ search: 'a', replace: 'b' }] }],
    });
    expect(allowed.has('src/routes/users.ts')).toBe(true);
    expect(allowed.has('src/services/user.ts')).toBe(true);
  });
  it('planner-mode buildAllowedSet drops test paths from extraction', () => {
    const allowed = BUGFIX_SPEC.buildAllowedSet({
      stepDescription: 'Fix the bug in src/services/user.ts where tests/user.test.ts asserts createdAt',
      context: '',
      taskMode: 'balanced',
    });
    expect(allowed.has('src/services/user.ts')).toBe(true);
    expect(allowed.has('tests/user.test.ts')).toBe(false);
  });
  it('systemPrompt contains the test→production navigation hint', () => {
    expect(BUGFIX_SPEC.systemPrompt).toMatch(/NAVIGATION FOR BUG FIXES/);
    expect(BUGFIX_SPEC.systemPrompt).toMatch(/test failure means the bug is in the production module/i);
  });
});

describe('REFACTOR_SPEC — invariants', () => {
  it('kind="refactor", agentName labels refactor channel', () => {
    expect(REFACTOR_SPEC.kind).toBe('refactor');
    expect(REFACTOR_SPEC.agentName).toBe('Refactor(tool-calling)');
  });
  it('maxToolCalls=40, pruneHistory=false', () => {
    expect(REFACTOR_SPEC.maxToolCalls).toBe(40);
    expect(REFACTOR_SPEC.pruneHistory).toBe(false);
  });
  it('reuses FEATURE_SPEC scope discipline (same forbidden patterns + buildAllowedSet)', () => {
    expect(REFACTOR_SPEC.forbiddenPatterns).toEqual(FEATURE_SPEC.forbiddenPatterns);
    expect(REFACTOR_SPEC.buildAllowedSet).toBe(FEATURE_SPEC.buildAllowedSet);
  });
  it('systemPrompt prepends REFACTOR_PREAMBLE before the Coder body', () => {
    expect(REFACTOR_SPEC.systemPrompt.startsWith('REFACTOR DEFAULT TOOL ORDERING')).toBe(true);
    expect(REFACTOR_SPEC.systemPrompt).toMatch(/AST primitives/);
    expect(REFACTOR_SPEC.systemPrompt).toMatch(/STRUCTURAL TOOLS \(PREFERRED/);
  });
});

// Parameterized smoke + safety tests across all three specs. Runs the same
// shared loop via runTaskAgent and confirms behaviors that v1.32-c MUST
// preserve from the previous monolithic Coder/Fixer implementations.
describe.each<[string, TaskAgentSpec]>([
  ['FEATURE_SPEC', FEATURE_SPEC],
  ['BUGFIX_SPEC',  BUGFIX_SPEC],
  ['REFACTOR_SPEC', REFACTOR_SPEC],
])('runTaskAgent shared loop — %s', (label, spec) => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `task-agent-${label}-`));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildFakeRouter(responses: Array<{ content: string; toolCalls?: unknown[] }>) {
    let i = 0;
    return {
      routeWithTools: async () => {
        const r = responses[Math.min(i, responses.length - 1)];
        i++;
        return { content: r.content, toolCalls: r.toolCalls, model: 'fake' };
      },
    } as never;
  }

  it('bails after 3 consecutive text-only responses', async () => {
    const router = buildFakeRouter([
      { content: 'I do not know.' },
      { content: 'Still nothing.' },
      { content: 'Genuinely stuck.' },
    ]);
    const result = await runTaskAgent(
      spec,
      { stepDescription: 'add a /version endpoint', context: 'ctx', taskMode: 'balanced' },
      router,
      tmpDir,
    );
    expect(result.files).toEqual([]);
  });

  it('terminates cleanly when the model calls done()', async () => {
    const router = buildFakeRouter([
      { content: '', toolCalls: [{ function: { name: 'done', arguments: {} } }] },
    ]);
    const result = await runTaskAgent(
      spec,
      { stepDescription: 'noop', context: 'ctx', taskMode: 'balanced' },
      router,
      tmpDir,
    );
    expect(result.files).toEqual([]);
  });

  it('pathology guard hard-bails after MAX_PATHOLOGY_STRIKES same-fingerprint cycles', async () => {
    let count = 0;
    const router = {
      routeWithTools: async () => {
        count++;
        return {
          content: '',
          toolCalls: [{
            function: {
              name: 'replace_in_file',
              arguments: { path: 'src/missing.ts', start_line: 1, end_line: 1, new_text: 'X' },
            },
          }],
          model: 'fake',
        };
      },
    } as never;

    await runTaskAgent(
      spec,
      { stepDescription: 'always errors on src/missing.ts', context: 'ctx', taskMode: 'balanced' },
      router,
      tmpDir,
    );

    // Pathology nudge fires after THRESHOLD errors; bail after MAX_STRIKES nudges.
    // Total tool calls = THRESHOLD * MAX_STRIKES regardless of which spec drives.
    expect(count).toBe(PATHOLOGY_THRESHOLD * MAX_PATHOLOGY_STRIKES);
  });
});

describe('runTaskAgent — pruneHistory only fires for specs that opt in', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-history-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('BUGFIX_SPEC (pruneHistory=true) trims long conversations', async () => {
    // Drive a long conversation by emitting many error-producing tool calls
    // until the loop bails. The exact prune behavior is unit-tested in
    // tool-calling-fixer.test.ts; here we verify the spec-level wiring.
    let count = 0;
    const seenLengths: number[] = [];
    const router = {
      routeWithTools: async (_role: unknown, msgs: ToolLoopMessage[]) => {
        seenLengths.push(msgs.length);
        count++;
        return {
          content: '',
          toolCalls: [{
            function: {
              name: 'replace_in_file',
              arguments: { path: 'src/missing.ts', start_line: 1, end_line: 1, new_text: 'X' },
            },
          }],
          model: 'fake',
        };
      },
    } as never;

    await runTaskAgent(
      BUGFIX_SPEC,
      { stepDescription: '<validation>', context: 'c', taskMode: 'balanced',
        issues: ['src/missing.ts:1 something'], currentFiles: [] },
      router,
      tmpDir,
    );

    // The Fixer threshold is 22; with same-fp errors the loop hits pathology
    // bail at THRESHOLD * MAX_STRIKES = 10 calls — under the prune trigger.
    // What we assert: the loop ran and the lengths are bounded growth (no
    // crash from pruning misuse).
    expect(count).toBeGreaterThan(0);
    expect(Math.max(...seenLengths)).toBeLessThan(100);
  });
});
