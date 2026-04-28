import { describe, it, expect } from 'vitest';
import type { FileChange } from '@rag-system/shared';
import type { ToolLoopMessage } from '@rag-system/model-router';
import { buildFixerAllowedSet, ToolCallingFixerAgent, pruneHistory } from '../tool-calling-fixer.js';

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
