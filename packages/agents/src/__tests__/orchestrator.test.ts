import { describe, it, expect, beforeEach, vi } from 'vitest';
import { taskEvents } from '@rag-system/shared';
import type { TaskEvent } from '@rag-system/shared';

vi.mock('@rag-system/shared', async () => {
  const actual = await vi.importActual<typeof import('@rag-system/shared')>('@rag-system/shared');
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    config: {
      ...actual.config,
      JOB_MAX_RETRIES: 1,
      projectRoot: '/tmp',
      agents: { parallelism: 3 },
    },
  };
});

vi.mock('@rag-system/safe-exec', () => ({
  SafeWriter: class {
    execute = vi.fn();
    get root() { return '/tmp'; }
  },
  TestRunner: class { run = vi.fn().mockResolvedValue({ success: true, output: '', exitCode: 0, durationMs: 0, skipped: 'mock' }); },
  TypeChecker: class {
    run = vi.fn().mockResolvedValue({ success: true, output: '', exitCode: 0, durationMs: 0, skipped: 'mock' });
    runOn = vi.fn().mockResolvedValue({ success: true, output: '', exitCode: 0, durationMs: 0, skipped: 'mock' });
  },
  PrettierRunner: class {
    run = vi.fn().mockResolvedValue({ success: true, formatted: [], output: '', durationMs: 0, skipped: 'mock' });
  },
  isPrettierConfigured: vi.fn(() => false),
  applyEdits: vi.fn((content: string) => ({ ok: true, result: content, tolerantEdits: [] })),
}));

const { Orchestrator } = await import('../orchestrator.js');

interface MockStore {
  saveTask: ReturnType<typeof vi.fn>;
  saveADR: ReturnType<typeof vi.fn>;
  saveFailure: ReturnType<typeof vi.fn>;
}

function buildOrchestrator(opts: {
  steps: Array<{ id: string; description: string; dependencies: string[] }>;
  failingStepIds?: Set<string>;
  architectDelayMs?: number;
  trackInFlight?: { current: number; peak: number };
}) {
  const store: MockStore = {
    saveTask: vi.fn(),
    saveADR: vi.fn(),
    saveFailure: vi.fn(),
  };

  const router = {};
  const retriever = {
    retrieveContext: vi.fn().mockResolvedValue(''),
    retrieveContextItems: vi.fn().mockResolvedValue([]),
    // buildRepoMap walks graph.getAll(); empty graph yields an empty repo-map
    // string, which is exactly what these scheduling-focused tests need.
    graph: { getAll: () => [] },
  };
  const writer = { execute: vi.fn(), root: '/tmp' };
  const git = {
    createBranchForTask: vi.fn().mockResolvedValue(undefined),
    commitChanges: vi.fn().mockResolvedValue('abc12345deadbeef0000000000000000abcdef00'),
  };

  const orch = new Orchestrator(
    router as never,
    retriever as never,
    writer as never,
    store as never,
    git as never,
  );

  // Stub agent calls
  (orch as unknown as { planner: { execute: ReturnType<typeof vi.fn> } }).planner = {
    execute: vi.fn().mockResolvedValue({ steps: opts.steps }),
  };
  (orch as unknown as { architect: { execute: ReturnType<typeof vi.fn> } }).architect = {
    execute: vi.fn(async (desc: string) => {
      const stepId = opts.steps.find(s => s.description === desc)?.id;
      if (opts.trackInFlight) {
        opts.trackInFlight.current++;
        opts.trackInFlight.peak = Math.max(opts.trackInFlight.peak, opts.trackInFlight.current);
      }
      try {
        if (opts.architectDelayMs) await new Promise(r => setTimeout(r, opts.architectDelayMs));
        if (stepId && opts.failingStepIds?.has(stepId)) {
          throw new Error(`architect blew up on ${stepId}`);
        }
        return { design: 'mock design' };
      } finally {
        if (opts.trackInFlight) opts.trackInFlight.current--;
      }
    }),
  };
  (orch as unknown as { coder: { execute: ReturnType<typeof vi.fn> } }).coder = {
    execute: vi.fn().mockResolvedValue({ files: [{ action: 'create', path: 'foo.ts', content: 'x' }] }),
  };
  (orch as unknown as { tester: { execute: ReturnType<typeof vi.fn> } }).tester = {
    execute: vi.fn().mockResolvedValue({ testFiles: [] }),
  };
  (orch as unknown as { reviewer: { execute: ReturnType<typeof vi.fn> } }).reviewer = {
    execute: vi.fn().mockResolvedValue({ isApproved: true, issues: [] }),
  };
  (orch as unknown as { fixer: { execute: ReturnType<typeof vi.fn> } }).fixer = {
    execute: vi.fn().mockResolvedValue({ files: [] }),
  };

  return { orch, store, git, writer };
}

describe('Orchestrator per-step recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips dependent step when its dependency fails, but continues independent ones', async () => {
    const { orch, store, git } = buildOrchestrator({
      steps: [
        { id: 'a', description: 'step a', dependencies: [] },
        { id: 'b', description: 'step b', dependencies: ['a'] },
        { id: 'c', description: 'step c', dependencies: [] },
      ],
      failingStepIds: new Set(['a']),
    });

    await orch.runTask('task-1', 'do stuff');

    // 'a' failed → recorded
    const failureCalls = store.saveFailure.mock.calls.map(c => c[0] as string);
    expect(failureCalls.some(p => p.startsWith('step-failure:a:'))).toBe(true);
    // 'b' skipped because depends on failed 'a'
    expect(failureCalls).toContain('step-skipped:b');
    // 'c' completed → commit was called for it
    expect(git.commitChanges).toHaveBeenCalledOnce();
    // task still saved with partial result
    expect(store.saveTask).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      result: expect.stringContaining('Completed 1/3 steps'),
    }));
  });

  it('throws when every step fails so caller can mark task failed', async () => {
    const { orch } = buildOrchestrator({
      steps: [
        { id: 'a', description: 'step a', dependencies: [] },
        { id: 'b', description: 'step b', dependencies: [] },
      ],
      failingStepIds: new Set(['a', 'b']),
    });

    await expect(orch.runTask('task-2', 'do stuff')).rejects.toThrow(/All 2 steps failed/);
  });

  it('happy path: all steps succeed, no failure records', async () => {
    const { orch, store } = buildOrchestrator({
      steps: [{ id: 'a', description: 'step a', dependencies: [] }],
    });

    await orch.runTask('task-3', 'do stuff');

    expect(store.saveFailure).not.toHaveBeenCalled();
    expect(store.saveTask).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      result: undefined,
    }));
  });

  it('runs independent steps in parallel up to the parallelism cap', async () => {
    const tracker = { current: 0, peak: 0 };
    const { orch } = buildOrchestrator({
      steps: [
        { id: 'a', description: 'a', dependencies: [] },
        { id: 'b', description: 'b', dependencies: [] },
        { id: 'c', description: 'c', dependencies: [] },
      ],
      architectDelayMs: 80,
      trackInFlight: tracker,
    });
    await orch.runTask('task-par', 'parallel');
    expect(tracker.peak).toBe(3);
  });

  it('serializes dependent steps even when room exists in the parallelism budget', async () => {
    const tracker = { current: 0, peak: 0 };
    const { orch } = buildOrchestrator({
      steps: [
        { id: 'a', description: 'a', dependencies: [] },
        { id: 'b', description: 'b', dependencies: ['a'] },
        { id: 'c', description: 'c', dependencies: ['b'] },
      ],
      architectDelayMs: 50,
      trackInFlight: tracker,
    });
    await orch.runTask('task-chain', 'chain');
    expect(tracker.peak).toBe(1);
  });

  it('rejects plans with dependency cycles', async () => {
    const { orch } = buildOrchestrator({
      steps: [
        { id: 'a', description: 'a', dependencies: ['b'] },
        { id: 'b', description: 'b', dependencies: ['a'] },
      ],
    });
    await expect(orch.runTask('task-cycle', 'cyclic')).rejects.toThrow(/dependency cycle/);
  });

  it('skips steps whose dependency id does not exist in the plan', async () => {
    const { orch, store } = buildOrchestrator({
      steps: [
        { id: 'a', description: 'a', dependencies: [] },
        { id: 'b', description: 'b', dependencies: ['ghost'] },
      ],
    });
    await orch.runTask('task-dangling', 'dangling');
    const failureCalls = store.saveFailure.mock.calls.map(c => c[0] as string);
    expect(failureCalls).toContain('step-skipped:b');
    expect(store.saveTask).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.stringContaining('Completed 1/2 steps'),
    }));
  });

  // v1.28 — partial completion must emit a `commit_partial` event and set
  // `done.data.partial = true` with the failed step ids surfaced. Otherwise
  // tasks where a step quietly didn't land report `done` with no signal —
  // exactly the L2.3 #1 v1.26 benchmark scenario where step3's DELETE
  // endpoint never made it but the operator saw only a regular `done`.
  it('emits commit_partial and partial:true on done when a step fails', async () => {
    const { orch } = buildOrchestrator({
      steps: [
        { id: 'a', description: 'a', dependencies: [] },
        { id: 'b', description: 'b', dependencies: [] },
      ],
      failingStepIds: new Set(['b']),
    });

    const taskId = 'task-partial-1';
    const captured: TaskEvent[] = [];
    const handler = (e: TaskEvent) => captured.push(e);
    taskEvents.on(`task:${taskId}`, handler);
    try {
      await orch.runTask(taskId, 'partial work');
    } finally {
      taskEvents.off(`task:${taskId}`, handler);
    }

    const partialEvent = captured.find(e => e.type === 'commit_partial');
    expect(partialEvent).toBeDefined();
    const partialData = partialEvent!.data as { failedStepIds: string[]; unrecoveredWrites: string[]; completedSteps: number; totalSteps: number };
    expect(partialData.failedStepIds).toEqual(['b']);
    expect(partialData.completedSteps).toBe(1);
    expect(partialData.totalSteps).toBe(2);

    const doneEvent = captured.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();
    const doneData = doneEvent!.data as { partial: boolean; failedStepIds: string[]; unrecoveredWrites: string[] };
    expect(doneData.partial).toBe(true);
    expect(doneData.failedStepIds).toEqual(['b']);
    expect(doneData.unrecoveredWrites).toEqual([]);

    // commit_partial must come before done so SSE consumers can react in order
    expect(captured.indexOf(partialEvent!)).toBeLessThan(captured.indexOf(doneEvent!));
  });

  it('does NOT emit commit_partial on a fully-successful task', async () => {
    const { orch } = buildOrchestrator({
      steps: [{ id: 'a', description: 'a', dependencies: [] }],
    });

    const taskId = 'task-clean-1';
    const captured: TaskEvent[] = [];
    const handler = (e: TaskEvent) => captured.push(e);
    taskEvents.on(`task:${taskId}`, handler);
    try {
      await orch.runTask(taskId, 'clean work');
    } finally {
      taskEvents.off(`task:${taskId}`, handler);
    }

    expect(captured.find(e => e.type === 'commit_partial')).toBeUndefined();
    const doneEvent = captured.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();
    const doneData = doneEvent!.data as { partial: boolean; failedStepIds: string[]; unrecoveredWrites: string[] };
    expect(doneData.partial).toBe(false);
    expect(doneData.failedStepIds).toEqual([]);
    expect(doneData.unrecoveredWrites).toEqual([]);
  });

  // v1.25.1 — validation-loop Fixer's writer.execute throws (typically a
  // hallucinated `search` block), the throw must NOT bubble up and crash the
  // whole task. The validation loop should treat it as another failed attempt
  // and either retry or fall through to commit_skipped on exhaustion.
  it('does not crash the task when validation-Fixer write throws', async () => {
    const { orch, store, writer } = buildOrchestrator({
      steps: [{ id: 'a', description: 'step a', dependencies: [] }],
    });

    // v1.35+ flow: typeChecker is called by (1) computeBaseline at task start,
    // (2) applyAndCheckTs pre-Reviewer check, then (3+) the validation loop.
    // Calls 1-2 pass so we reach validation; calls 3+ keep failing so the Fixer
    // is invoked and write-throws are exercised. Pins the validation-loop crash
    // behavior, not the pre-check.
    let typeCheckCalls = 0;
    const failingTypeCheck = vi.fn(async () => {
      typeCheckCalls++;
      return typeCheckCalls <= 2
        ? { success: true, output: '', exitCode: 0, durationMs: 5 }
        : { success: false, output: 'TS2304: Cannot find name X', exitCode: 2, durationMs: 5 };
    });
    (orch as unknown as { typeChecker: { run: typeof failingTypeCheck; runOn: typeof failingTypeCheck } }).typeChecker = {
      run: failingTypeCheck,
      runOn: failingTypeCheck,
    };

    // Validation Fixer returns a modify edit that the writer will reject.
    (orch as unknown as { fixer: { execute: ReturnType<typeof vi.fn> } }).fixer = {
      execute: vi.fn().mockResolvedValue({
        files: [{ action: 'modify', path: 'foo.ts', edits: [{ search: 'NOT_PRESENT', replace: 'X' }] }],
      }),
    };

    // First write is the initial Coder output (passes); subsequent writes
    // come from the validation Fixer and must throw.
    let writeCount = 0;
    writer.execute.mockImplementation(() => {
      writeCount++;
      if (writeCount === 1) return; // Coder's create succeeds
      throw new Error('SafeWriter.execute: edit-apply failed for foo.ts: edit #1: search string not found');
    });

    // The bug being fixed: previously this rejected; now it should resolve and
    // the task should be saved as completed (with commit_skipped semantics).
    await expect(orch.runTask('task-validation-throw', 'tricky')).resolves.toBeUndefined();

    expect(store.saveTask).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
    }));
    // The Fixer write throw should have been seen by the loop; saveFailure
    // gets a 'validation-failure' entry once the retry budget is exhausted.
    const failureKeys = store.saveFailure.mock.calls.map(c => c[0] as string);
    expect(failureKeys.some(k => k.startsWith('validation-failure:'))).toBe(true);
  });

  // v1.32-a.2 — when validation succeeds because the Fixer wrote a path that
  // the Coder never touched (typical for navigational bug-fix tasks: Coder
  // edits routes/users.ts cosmetically, Fixer reads & fixes services/user-service.ts),
  // the commit must stage BOTH paths. Without the v1.32-a.2 aggregation, the
  // commit step received only Coder's paths — `git.add(coderPaths)` staged
  // nothing useful, `git.commit` produced no commit, and the Fixer's correct
  // fix lived in the working tree as a dirty file. This test pins the bug
  // shut: Fixer's writes are aggregated into the commit's file list.
  it('commits Fixer-produced paths even when Coder did not touch them', async () => {
    const { orch, store, git, writer } = buildOrchestrator({
      steps: [{ id: 'a', description: 'fix a bug', dependencies: [] }],
    });

    // Coder writes routes/users.ts. Fixer (later) writes services/user-service.ts —
    // a path Coder never opened. Both writes succeed at SafeWriter.
    (orch as unknown as { coder: { execute: ReturnType<typeof vi.fn> } }).coder = {
      execute: vi.fn().mockResolvedValue({
        files: [{ action: 'create', path: 'src/routes/users.ts', content: 'route' }],
      }),
    };

    // v1.35+ flow: 3 typeChecker call sites — (1) computeBaseline, (2) applyAndCheckTs,
    // (3+) validation loop. Calls 1-2 pass so the test exercises the validation-loop
    // Fixer aggregation. Call 3 fails (validation iter 1), call 4 passes (post-Fixer).
    let typeCalls = 0;
    const flakyTypeCheck = vi.fn(async () => {
      typeCalls++;
      if (typeCalls <= 2) return { success: true, output: '', exitCode: 0, durationMs: 5 };
      if (typeCalls === 3) return { success: false, output: 'AssertionError: expected user.createdAt to be truthy', exitCode: 1, durationMs: 5 };
      return { success: true, output: '', exitCode: 0, durationMs: 5 };
    });
    (orch as unknown as { typeChecker: { run: typeof flakyTypeCheck; runOn: typeof flakyTypeCheck } }).typeChecker = {
      run: flakyTypeCheck,
      runOn: flakyTypeCheck,
    };
    (orch as unknown as { testRunner: { run: ReturnType<typeof vi.fn> } }).testRunner = {
      run: vi.fn().mockResolvedValue({ success: true, output: '', exitCode: 0, durationMs: 5 }),
    };

    // Fixer's "fix" is on a different file than the Coder's output.
    (orch as unknown as { fixer: { execute: ReturnType<typeof vi.fn> } }).fixer = {
      execute: vi.fn().mockResolvedValue({
        files: [{ action: 'create', path: 'src/services/user-service.ts', content: 'fixed' }],
      }),
    };

    await expect(orch.runTask('task-32a2', 'fix the createdAt bug')).resolves.toBeUndefined();

    // Validation eventually passed → commit fires.
    expect(git.commitChanges).toHaveBeenCalledTimes(1);
    const stagedFiles = git.commitChanges.mock.calls[0]![2] as string[];
    // Both Coder's path AND Fixer's path are staged. v1.32-a.2 aggregation.
    expect(stagedFiles).toContain('src/routes/users.ts');
    expect(stagedFiles).toContain('src/services/user-service.ts');
    // Both writer.execute paths fired (Coder's path on initial, Fixer's during validation loop).
    const writtenPaths = writer.execute.mock.calls.map(c => (c[0] as { path: string }).path);
    expect(writtenPaths).toContain('src/routes/users.ts');
    expect(writtenPaths).toContain('src/services/user-service.ts');

    expect(store.saveTask).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  // v1.32-a.2 — guard: if the same path appears in both Coder's output and the
  // Fixer's output (Fixer touched the file Coder created/modified), the
  // commit step must not double-stage it. Dedupe-by-existence.
  it('dedupes the staged file list when Coder and Fixer touched the same path', async () => {
    const { orch, git } = buildOrchestrator({
      steps: [{ id: 'a', description: 'tweak foo.ts', dependencies: [] }],
    });

    (orch as unknown as { coder: { execute: ReturnType<typeof vi.fn> } }).coder = {
      execute: vi.fn().mockResolvedValue({
        files: [{ action: 'create', path: 'src/foo.ts', content: 'initial' }],
      }),
    };

    // Calls: 1=computeBaseline, 2=applyAndCheckTs, 3=validation iter 1 (fail), 4+=after Fixer (pass).
    let typeCalls = 0;
    const flakyTypeCheck = vi.fn(async () => {
      typeCalls++;
      if (typeCalls <= 2) return { success: true, output: '', exitCode: 0, durationMs: 5 };
      if (typeCalls === 3) return { success: false, output: 'TS2304', exitCode: 1, durationMs: 5 };
      return { success: true, output: '', exitCode: 0, durationMs: 5 };
    });
    (orch as unknown as { typeChecker: { run: typeof flakyTypeCheck; runOn: typeof flakyTypeCheck } }).typeChecker = {
      run: flakyTypeCheck,
      runOn: flakyTypeCheck,
    };
    (orch as unknown as { testRunner: { run: ReturnType<typeof vi.fn> } }).testRunner = {
      run: vi.fn().mockResolvedValue({ success: true, output: '', exitCode: 0, durationMs: 5 }),
    };

    // Fixer edits the SAME path Coder produced.
    (orch as unknown as { fixer: { execute: ReturnType<typeof vi.fn> } }).fixer = {
      execute: vi.fn().mockResolvedValue({
        files: [{ action: 'create', path: 'src/foo.ts', content: 'fixed' }],
      }),
    };

    await orch.runTask('task-32a2-dedup', 'task');

    expect(git.commitChanges).toHaveBeenCalledTimes(1);
    const stagedFiles = git.commitChanges.mock.calls[0]![2] as string[];
    expect(stagedFiles).toEqual(['src/foo.ts']);
  });
});

// v1.32-d.1 — Fixer's output is merged into Coder's prior changes by path.
// L1.1 first run on llama-swap surfaced the prior bug: Coder produced server.ts,
// Reviewer rejected, Fixer produced ONLY a test-file edit, the wholesale
// `currentChanges = fixerResult.files` dropped Coder's correct route addition.
// The merge keeps Coder's edits for paths Fixer didn't touch.
const { mergeFixerChanges } = await import('../orchestrator.js');

describe('mergeFixerChanges — Fixer output merge semantics', () => {
  it('preserves Coder paths Fixer did not touch', () => {
    const coder = [
      { action: 'modify' as const, path: 'src/server.ts', edits: [{ search: 'a', replace: 'b' }] },
      { action: 'create' as const, path: 'src/util.ts', content: 'export {}' },
    ];
    const fixer = [
      { action: 'modify' as const, path: 'src/__tests__/x.test.ts', edits: [{ search: 'c', replace: 'd' }] },
    ];
    const merged = mergeFixerChanges(coder, fixer);
    expect(merged.map(c => c.path).sort()).toEqual(
      ['src/__tests__/x.test.ts', 'src/server.ts', 'src/util.ts'].sort(),
    );
    // Coder's server.ts edit MUST survive — that's the L1.1 regression class.
    const server = merged.find(c => c.path === 'src/server.ts')!;
    expect(server.action).toBe('modify');
  });

  it('Fixer wins on shared paths (Fixer fixes Coder there)', () => {
    const coder = [
      { action: 'modify' as const, path: 'src/server.ts', edits: [{ search: 'old-a', replace: 'old-b' }] },
    ];
    const fixer = [
      { action: 'modify' as const, path: 'src/server.ts', edits: [{ search: 'new-a', replace: 'new-b' }] },
    ];
    const merged = mergeFixerChanges(coder, fixer);
    expect(merged).toHaveLength(1);
    expect(merged[0].path).toBe('src/server.ts');
    expect(merged[0].action).toBe('modify');
    // Fixer's edits are the ones in the merged entry — not concatenated.
    const edits = (merged[0] as { edits: Array<{ search: string }> }).edits;
    expect(edits[0].search).toBe('new-a');
  });

  it('empty fixer output keeps Coder unchanged', () => {
    const coder = [{ action: 'create' as const, path: 'src/a.ts', content: 'x' }];
    const merged = mergeFixerChanges(coder, []);
    expect(merged).toEqual(coder);
    // Should not be the same reference (returns fresh array).
    expect(merged).not.toBe(coder);
  });

  it('empty Coder output passes Fixer through unchanged', () => {
    const fixer = [{ action: 'create' as const, path: 'src/b.ts', content: 'y' }];
    const merged = mergeFixerChanges([], fixer);
    expect(merged).toEqual(fixer);
  });
});
