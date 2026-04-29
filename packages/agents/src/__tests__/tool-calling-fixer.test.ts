import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import type { FileChange } from '@rag-system/shared';
import type { ToolLoopMessage } from '@rag-system/model-router';
import { buildFixerAllowedSet, ToolCallingFixerAgent, pruneHistory } from '../tool-calling-fixer.js';
import { isWriteAllowed } from '../tool-calling-coder.js';
import { WorkingSet } from '../working-set.js';

describe('buildFixerAllowedSet', () => {
  it('includes all file paths the Coder produced', () => {
    const files: FileChange[] = [
      { action: 'create', path: 'src/foo.ts', content: 'x' },
      { action: 'create', path: 'src/bar.ts', content: 'y' },
      { action: 'delete', path: 'src/old.ts' },
    ];
    const out = buildFixerAllowedSet(files, []);
    expect(out.has('src/foo.ts')).toBe(true);
    expect(out.has('src/bar.ts')).toBe(true);
    expect(out.has('src/old.ts')).toBe(true);
  });

  it('extracts paths from typecheck-style issue messages', () => {
    const issues = [
      'TypeScript compilation failed (exit 2):\nsrc/server.ts(42,5): error TS2304: Cannot find name X.',
      'src/utils/helpers.ts(7,12): error TS2362: ...',
    ];
    const out = buildFixerAllowedSet([], issues);
    expect(out.has('src/server.ts')).toBe(true);
    expect(out.has('src/utils/helpers.ts')).toBe(true);
  });

  it('unions Coder paths and issue-mentioned paths', () => {
    const files: FileChange[] = [{ action: 'create', path: 'src/coder-output.ts', content: 'z' }];
    const issues = ['src/elsewhere.ts: TS error'];
    const out = buildFixerAllowedSet(files, issues);
    expect(out.has('src/coder-output.ts')).toBe(true);
    expect(out.has('src/elsewhere.ts')).toBe(true);
    expect(out.size).toBe(2);
  });

  it('returns empty when no Coder files and no path-bearing issues', () => {
    const out = buildFixerAllowedSet([], ['Tests failed (exit 1):\nUnknown error']);
    expect(out.size).toBe(0);
  });

  it('does not double-count when the same path appears in both sources', () => {
    const files: FileChange[] = [{ action: 'create', path: 'src/foo.ts', content: 'x' }];
    const issues = ['src/foo.ts(1,1): error TS2304'];
    const out = buildFixerAllowedSet(files, issues);
    expect(out.size).toBe(1);
  });

  // v1.32-a — test-scope discipline. Issue messages quoting test files don't
  // automatically open them up to Fixer writes, because the cheapest way to
  // silence a failing assertion is to mutate the assertion. L4.1 bench (2026-04-30)
  // observed exactly this — Fixer "fixed" `expect(user.createdAt).toBeTruthy()`
  // by adding `user.createdAt = new Date()` instead of fixing the production bug.
  describe('v1.32-a test-scope discipline', () => {
    it('drops top-level tests/ paths from issue mentions when Coder did not touch them', () => {
      const files: FileChange[] = [
        { action: 'create', path: 'src/services/user-service.ts', content: 'x' },
      ];
      const issues = [
        'tests/users.test.ts > UserService > creates a user with timestamp\nAssertionError: expected undefined to be truthy',
      ];
      const out = buildFixerAllowedSet(files, issues);
      expect(out.has('src/services/user-service.ts')).toBe(true);
      expect(out.has('tests/users.test.ts')).toBe(false);
    });

    it('drops co-located __tests__/ paths from issue mentions when Coder did not touch them', () => {
      const files: FileChange[] = [
        { action: 'create', path: 'packages/agents/src/foo.ts', content: 'x' },
      ];
      const issues = [
        'packages/agents/src/__tests__/foo.test.ts(15,3): error TS2304: Cannot find name X.',
      ];
      const out = buildFixerAllowedSet(files, issues);
      expect(out.has('packages/agents/src/foo.ts')).toBe(true);
      expect(out.has('packages/agents/src/__tests__/foo.test.ts')).toBe(false);
    });

    it('drops .test.ts and .spec.ts files (file-suffix convention) from issue mentions', () => {
      const files: FileChange[] = [{ action: 'create', path: 'src/util.ts', content: 'x' }];
      const issues = [
        'src/util.test.ts(1,1): error',
        'src/util.spec.ts(1,1): error',
      ];
      const out = buildFixerAllowedSet(files, issues);
      expect(out.has('src/util.ts')).toBe(true);
      expect(out.has('src/util.test.ts')).toBe(false);
      expect(out.has('src/util.spec.ts')).toBe(false);
    });

    it('keeps test paths the Coder explicitly produced (legitimate test edits stay in scope)', () => {
      const files: FileChange[] = [
        { action: 'create', path: 'src/foo.ts', content: 'x' },
        { action: 'create', path: 'tests/foo.test.ts', content: 'y' },
      ];
      const issues = ['tests/foo.test.ts(3,5): error TS2304'];
      const out = buildFixerAllowedSet(files, issues);
      expect(out.has('src/foo.ts')).toBe(true);
      // Coder produced this test; Fixer can keep editing it on its follow-up.
      expect(out.has('tests/foo.test.ts')).toBe(true);
    });

    it('non-test paths flow through unchanged regardless of issue source', () => {
      // The filter targets test files specifically; production-code paths
      // mentioned in issues should NOT be dropped.
      const files: FileChange[] = [{ action: 'create', path: 'src/coder-output.ts', content: 'z' }];
      const issues = [
        'src/services/user-service.ts(15,3): error TS2304',
        'src/routes/users.ts(22,5): error TS2304',
      ];
      const out = buildFixerAllowedSet(files, issues);
      expect(out.has('src/coder-output.ts')).toBe(true);
      expect(out.has('src/services/user-service.ts')).toBe(true);
      expect(out.has('src/routes/users.ts')).toBe(true);
    });

    it('drops a deeply-nested __tests__ path even when error format varies', () => {
      const files: FileChange[] = [
        { action: 'create', path: 'packages/agents/src/orchestrator.ts', content: 'x' },
      ];
      const issues = [
        '× packages/agents/src/__tests__/orchestrator.test.ts > Orchestrator > runs all steps',
      ];
      const out = buildFixerAllowedSet(files, issues);
      expect(out.has('packages/agents/src/__tests__/orchestrator.test.ts')).toBe(false);
    });
  });

  // v1.32-a.1 — closes the read-grants-write loophole for test files.
  // Without test paths in Fixer's forbidden list, a model could read a test
  // file (which is unrestricted) and then gain write access via the
  // read-grants-write rule. Combined with v1.32-a's filter, this would
  // re-open the L4.1 game-the-test path. Test paths are forbidden for Fixer
  // unless Coder explicitly produced them (in which case they're in
  // policy.allowed and the explicit-allow wins over the forbidden check).
  describe('Fixer test-path forbidden + read-grants-write interaction', () => {
    let tmpDir: string;
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-test-rgw-'));
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function write(rel: string, content: string): void {
      const abs = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }

    // Replays the live policy Fixer constructs in execute(): allowed set
    // built from Coder paths + filtered issue paths; forbidden = configs +
    // test patterns.
    const fixerForbidden: RegExp[] = [
      /(?:^|\/)package\.json$/,
      /(?:^|\/)tests\//,
      /(?:^|\/)__tests__\//,
      /\.test\.(?:ts|tsx|js|jsx|mjs|cjs)$/,
      /\.spec\.(?:ts|tsx|js|jsx|mjs|cjs)$/,
    ];

    it('blocks write to a test path even after the model reads it', () => {
      write('tests/users.test.ts', 'expect(x).toBeTruthy();\n');
      const ws = new WorkingSet(tmpDir);
      const policy = {
        allowed: new Set(['src/routes/users.ts']),
        forbiddenPatterns: fixerForbidden,
      };

      // Model reads the test file (allowed — read_file is unrestricted).
      ws.read('tests/users.test.ts');

      // But cannot write — forbidden pattern wins because path is not in allowed.
      const r = isWriteAllowed('tests/users.test.ts', policy, ws);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/protected configuration/);
    });

    it('still allows write to a Coder-produced test (explicit allow wins)', () => {
      write('tests/foo.test.ts', 'x\n');
      const ws = new WorkingSet(tmpDir);
      // Coder produced this test → it's in allowed → forbidden check yields.
      const policy = {
        allowed: new Set(['tests/foo.test.ts', 'src/foo.ts']),
        forbiddenPatterns: fixerForbidden,
      };
      const r = isWriteAllowed('tests/foo.test.ts', policy, ws);
      expect(r.ok).toBe(true);
    });

    it('allows write to a non-test production path after read (read-grants-write still works)', () => {
      write('src/services/user-service.ts', 'export class X {}\n');
      const ws = new WorkingSet(tmpDir);
      const policy = {
        allowed: new Set(['src/routes/users.ts']),
        forbiddenPatterns: fixerForbidden,
      };
      ws.read('src/services/user-service.ts');
      const r = isWriteAllowed('src/services/user-service.ts', policy, ws);
      expect(r.ok).toBe(true);
    });
  });
});

describe('ToolCallingFixerAgent shape', () => {
  it('exposes the expected role and name', () => {
    // Minimal smoke check: instantiating with a shaped router and reading the
    // public fields is enough — the heavy logic is covered by the dispatcher
    // tests in tool-calling-coder.test.ts (Fixer reuses the same dispatcher).
    const fakeRouter = {} as never;
    const agent = new ToolCallingFixerAgent(fakeRouter);
    expect(agent.role).toBe('fixer');
    expect(agent.name).toBe('Fixer(tool-calling)');
  });
});

// v1.32-a.3 — Fixer reliability: when the model returns no tool calls, the
// loop nudges twice with progressively stronger instructions before bailing.
// Surfaced by L4.1 v1.32-a.2 where the previous one-shot retry let the model
// bail ~50% of the time, never reaching the commit-aggregation path.
describe('ToolCallingFixerAgent.execute — no-tool-calls retry (v1.32-a.3)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-no-tools-'));
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
      { content: 'I cannot do this.' },
      { content: 'Still cannot.' },
      { content: 'Genuinely stuck.' },
      // Response 4 would never be reached if the bail happens at 3.
    ]);
    const agent = new ToolCallingFixerAgent(router);
    const result = await agent.execute(
      ['src/foo.ts:42: TS2304: Cannot find name X'],
      [{ action: 'create', path: 'src/foo.ts', content: 'x' }],
      'context',
      'balanced',
      tmpDir,
    );
    expect(result.files).toEqual([]);
  });

  it('continues normally when a text-only response is followed by tool calls', async () => {
    const filePath = path.join(tmpDir, 'src/foo.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "export const X = 1;\n");

    const router = buildFakeRouter([
      // Round 0: text-only response → triggers nudge #1.
      { content: 'Let me think...' },
      // Round 1: real tool call (read_file) → nudge counter resets, loop proceeds.
      { content: '', toolCalls: [{ function: { name: 'read_file', arguments: { path: 'src/foo.ts' } } }] },
      // Round 2: done().
      { content: '', toolCalls: [{ function: { name: 'done', arguments: {} } }] },
    ]);
    const agent = new ToolCallingFixerAgent(router);
    const result = await agent.execute(
      ['src/foo.ts:1: TS2304'],
      [{ action: 'create', path: 'src/foo.ts', content: 'x' }],
      'context',
      'balanced',
      tmpDir,
    );
    // No file changes since Fixer only read; non-empty result not required.
    // The key property: the loop didn't bail at the first text-only response.
    expect(result.files).toEqual([]);
  });

  it('emits progressively stronger nudges (round 1 vs round 2)', async () => {
    // Spy on the router to inspect what message content the agent sent on
    // each subsequent call. Captures the assistant + nudge messages added
    // between calls.
    const calls: ToolLoopMessage[][] = [];
    const router = {
      routeWithTools: async (_role: unknown, messages: ToolLoopMessage[]) => {
        calls.push([...messages]);
        return { content: 'no.', toolCalls: [], model: 'fake' };
      },
    } as never;
    const agent = new ToolCallingFixerAgent(router);
    await agent.execute(
      ['src/foo.ts:1: TS2304'],
      [{ action: 'create', path: 'src/foo.ts', content: 'x' }],
      'context',
      'balanced',
      tmpDir,
    );
    // 3 calls expected: initial + nudge #1 + nudge #2 → bail.
    expect(calls.length).toBe(3);
    // Last user message in call #2 is the first nudge; in call #3 — the second.
    const lastUser2 = [...calls[1]!].reverse().find(m => m.role === 'user')!;
    const lastUser3 = [...calls[2]!].reverse().find(m => m.role === 'user')!;
    expect(lastUser2.content).toMatch(/no preamble/);
    expect(lastUser3.content).toMatch(/RIGHT NOW/);
    // The second nudge is harder than the first — they must differ.
    expect(lastUser2.content).not.toBe(lastUser3.content);
  });
});

describe('pruneHistory', () => {
  function makeRound(i: number): ToolLoopMessage[] {
    return [
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: `f${i}.ts` } } }] },
      { role: 'tool', content: `# f${i}.ts (3 lines)\n   1 | x\n   2 | y\n   3 | z`, tool_name: 'read_file' },
    ];
  }

  function buildLongHistory(rounds: number): ToolLoopMessage[] {
    const messages: ToolLoopMessage[] = [
      { role: 'system', content: 'fixer system prompt' },
      { role: 'user', content: 'initial task: fix issues' },
    ];
    for (let i = 0; i < rounds; i++) messages.push(...makeRound(i));
    return messages;
  }

  it('does nothing when history is below threshold', () => {
    const messages = buildLongHistory(5); // 2 + 10 = 12 messages, under threshold
    const before = messages.length;
    const pruned = pruneHistory(messages);
    expect(pruned).toBe(false);
    expect(messages.length).toBe(before);
  });

  it('preserves system prompt + initial user message even after pruning', () => {
    const messages = buildLongHistory(20); // 2 + 40 = 42 messages, well over
    pruneHistory(messages);
    expect(messages[0].content).toBe('fixer system prompt');
    expect(messages[1].content).toBe('initial task: fix issues');
  });

  it('keeps the most recent rounds intact (newest tool result preserved)', () => {
    const messages = buildLongHistory(20);
    // Last tool message should be from round 19 — name f19.ts
    pruneHistory(messages);
    const last = messages[messages.length - 1];
    expect(last.role).toBe('tool');
    expect(last.content).toContain('f19.ts');
  });

  it('inserts a truncation note where the omission happened', () => {
    const messages = buildLongHistory(20);
    pruneHistory(messages);
    const note = messages.find(m => typeof m.content === 'string' && m.content.startsWith('[Conversation pruned'));
    expect(note).toBeDefined();
    expect(note!.role).toBe('user');
  });

  it('after pruning, total message count fits the configured budget', () => {
    const messages = buildLongHistory(50); // 2 + 100 = 102 messages
    pruneHistory(messages);
    // 2 head + 1 note + 16 tail = 19
    expect(messages.length).toBe(19);
  });

  it('returns true when pruning fired and false otherwise', () => {
    expect(pruneHistory(buildLongHistory(5))).toBe(false);
    expect(pruneHistory(buildLongHistory(20))).toBe(true);
  });
});
