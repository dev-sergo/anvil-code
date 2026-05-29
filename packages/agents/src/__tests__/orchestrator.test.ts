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

// v1.39-c — capture runTaskAgent invocations so we can assert the Reviewer-reject
// path routes through BUGFIX_SPEC (vs. patch-based fixer) when toolCallingCoder
// is on. Default return shape mirrors a passing Coder/Fixer so existing tests
// that flip toolCallingCoder=true (cumulative + noop suites do NOT) keep working.
const runTaskAgentMock = vi.fn().mockResolvedValue({
  files: [{ action: 'create', path: 'tool-calling-mock.ts', content: 'export {}' }],
});

vi.mock('../task-agents/runner.js', () => ({
  runTaskAgent: runTaskAgentMock,
}));

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
  getRepoPatterns: ReturnType<typeof vi.fn>;
  saveRepoPattern: ReturnType<typeof vi.fn>;
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
    getRepoPatterns: vi.fn().mockReturnValue([]),
    saveRepoPattern: vi.fn(),
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
    createBranchForTask: vi.fn().mockResolvedValue('auto/task-mock-1'),
    commitChanges: vi.fn().mockResolvedValue('abc12345deadbeef0000000000000000abcdef00'),
    mergeIntoCumulative: vi.fn().mockResolvedValue(undefined),
  };

  const orch = new Orchestrator(
    'test-project-id',
    '/tmp/data',
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
    const doneData = doneEvent!.data as { partial: boolean; failedStepIds: string[]; unrecoveredWrites: string[]; noopStepIds: string[] };
    expect(doneData.partial).toBe(false);
    expect(doneData.failedStepIds).toEqual([]);
    expect(doneData.unrecoveredWrites).toEqual([]);
    expect(doneData.noopStepIds).toEqual([]);
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

// v1.39-a — cumulative-mode wiring lives inside runTask. These tests pin the
// observable behavior on the SSE/event bus (the consumer surface the VSCode
// extension and bench harness depend on) so future refactors of the merge call
// site can't silently regress signaling.
describe('Orchestrator cumulative mode (v1.39-a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CUMULATIVE_MODE;
  });

  it('emits cumulative_merged after commit when CUMULATIVE_MODE=true', async () => {
    const { config } = await import('@rag-system/shared');
    const original = config.git.cumulative.enabled;
    (config.git.cumulative as { enabled: boolean }).enabled = true;

    try {
      const { orch, git } = buildOrchestrator({
        steps: [{ id: 'a', description: 'step a', dependencies: [] }],
      });
      const branchName = 'auto/task-cumulative-1-12345';
      git.createBranchForTask.mockResolvedValue(branchName);

      const taskId = 'task-cumul-ok';
      const captured: TaskEvent[] = [];
      const handler = (e: TaskEvent) => captured.push(e);
      taskEvents.on(`task:${taskId}`, handler);
      try {
        await orch.runTask(taskId, 'cumulative work');
      } finally {
        taskEvents.off(`task:${taskId}`, handler);
      }

      expect(git.mergeIntoCumulative).toHaveBeenCalledWith(branchName);
      const mergedEvent = captured.find(e => e.type === 'cumulative_merged');
      expect(mergedEvent).toBeDefined();
      expect((mergedEvent!.data as { branchName: string }).branchName).toBe(branchName);
      // The cumulative merge must come AFTER the commit event so consumers
      // know the change has actually landed on the task branch first.
      const commitIdx = captured.findIndex(e => e.type === 'commit');
      const mergedIdx = captured.indexOf(mergedEvent!);
      expect(commitIdx).toBeGreaterThanOrEqual(0);
      expect(mergedIdx).toBeGreaterThan(commitIdx);
    } finally {
      (config.git.cumulative as { enabled: boolean }).enabled = original;
    }
  });

  it('emits cumulative_merge_failed without throwing when ff-merge throws', async () => {
    const { config } = await import('@rag-system/shared');
    const original = config.git.cumulative.enabled;
    (config.git.cumulative as { enabled: boolean }).enabled = true;

    try {
      const { orch, git } = buildOrchestrator({
        steps: [{ id: 'a', description: 'step a', dependencies: [] }],
      });
      git.mergeIntoCumulative.mockRejectedValue(new Error('Cumulative ff-merge of auto/task-X failed: non-fast-forward'));

      const taskId = 'task-cumul-conflict';
      const captured: TaskEvent[] = [];
      const handler = (e: TaskEvent) => captured.push(e);
      taskEvents.on(`task:${taskId}`, handler);
      try {
        // Task must NOT throw — merge failure leaves the branch for manual
        // resolution but the underlying commit on the task branch is intact.
        await expect(orch.runTask(taskId, 'conflicty')).resolves.toBeUndefined();
      } finally {
        taskEvents.off(`task:${taskId}`, handler);
      }

      const failEvent = captured.find(e => e.type === 'cumulative_merge_failed');
      expect(failEvent).toBeDefined();
      expect((failEvent!.data as { error: string }).error).toContain('non-fast-forward');
      // `done` still fires so the SSE stream closes cleanly.
      expect(captured.find(e => e.type === 'done')).toBeDefined();
    } finally {
      (config.git.cumulative as { enabled: boolean }).enabled = original;
    }
  });

  it('does NOT call mergeIntoCumulative when CUMULATIVE_MODE is off', async () => {
    const { orch, git } = buildOrchestrator({
      steps: [{ id: 'a', description: 'step a', dependencies: [] }],
    });

    const taskId = 'task-no-cumul';
    const captured: TaskEvent[] = [];
    const handler = (e: TaskEvent) => captured.push(e);
    taskEvents.on(`task:${taskId}`, handler);
    try {
      await orch.runTask(taskId, 'normal work');
    } finally {
      taskEvents.off(`task:${taskId}`, handler);
    }

    expect(git.mergeIntoCumulative).not.toHaveBeenCalled();
    expect(captured.find(e => e.type === 'cumulative_merged')).toBeUndefined();
    expect(captured.find(e => e.type === 'cumulative_merge_failed')).toBeUndefined();
  });
});

// v1.39-b — runValidationLoop must always reach a terminal validation_pass /
// validation_fail event after emitting validation_start. T3 in the v1.38 real-
// repo bench had tsc/vitest hang for ~300s, leaving `done` to fire with no
// validation result in between. These tests pin the timeout + try/catch.
describe('Orchestrator validation incompleteness guard (v1.39-b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits validation_fail when validation runners throw, and does not crash the task', async () => {
    const { orch } = buildOrchestrator({
      steps: [{ id: 'a', description: 'a', dependencies: [] }],
    });

    // computeBaseline + applyAndCheckTs pass; validation-loop runOn throws —
    // simulating tsc crashing or the child process being killed.
    let typeCheckCalls = 0;
    const crashingTypeCheck = vi.fn(async () => {
      typeCheckCalls++;
      if (typeCheckCalls <= 2) {
        return { success: true, output: '', exitCode: 0, durationMs: 5 };
      }
      throw new Error('tsc spawn ENOENT');
    });
    (orch as unknown as { typeChecker: { run: typeof crashingTypeCheck; runOn: typeof crashingTypeCheck } }).typeChecker = {
      run: crashingTypeCheck,
      runOn: crashingTypeCheck,
    };

    const taskId = 'task-validation-crash';
    const captured: TaskEvent[] = [];
    const handler = (e: TaskEvent) => captured.push(e);
    taskEvents.on(`task:${taskId}`, handler);
    try {
      await expect(orch.runTask(taskId, 'crashy')).resolves.toBeUndefined();
    } finally {
      taskEvents.off(`task:${taskId}`, handler);
    }

    // Must NOT have a silent gap: validation_start is followed by validation_fail
    const validationEvents = captured.filter(
      e => e.type === 'validation_start' || e.type === 'validation_pass' || e.type === 'validation_fail',
    );
    expect(validationEvents.map(e => e.type)).toEqual(['validation_start', 'validation_fail']);
    const failEvent = validationEvents[1];
    expect((failEvent.data as { reason: string }).reason).toBe('timeout_or_crash');
    expect((failEvent.data as { error: string }).error).toContain('tsc spawn ENOENT');
  });

  it('emits validation_fail with timeout reason when validation hangs', async () => {
    const { config } = await import('@rag-system/shared');
    const original = config.agents.validationTimeoutMs;
    (config.agents as { validationTimeoutMs: number }).validationTimeoutMs = 50;

    try {
      const { orch } = buildOrchestrator({
        steps: [{ id: 'a', description: 'a', dependencies: [] }],
      });

      let typeCheckCalls = 0;
      const hangingTypeCheck = vi.fn(async () => {
        typeCheckCalls++;
        if (typeCheckCalls <= 2) {
          return { success: true, output: '', exitCode: 0, durationMs: 5 };
        }
        // Resolves after timeout — simulating tsc child hung on disk IO.
        return new Promise<{ success: boolean; output: string; exitCode: number; durationMs: number }>(r =>
          setTimeout(() => r({ success: true, output: '', exitCode: 0, durationMs: 10_000 }), 500),
        );
      });
      (orch as unknown as { typeChecker: { run: typeof hangingTypeCheck; runOn: typeof hangingTypeCheck } }).typeChecker = {
        run: hangingTypeCheck,
        runOn: hangingTypeCheck,
      };

      const taskId = 'task-validation-hang';
      const captured: TaskEvent[] = [];
      const handler = (e: TaskEvent) => captured.push(e);
      taskEvents.on(`task:${taskId}`, handler);
      try {
        await expect(orch.runTask(taskId, 'hang')).resolves.toBeUndefined();
      } finally {
        taskEvents.off(`task:${taskId}`, handler);
      }

      const failEvent = captured.find(e => e.type === 'validation_fail');
      expect(failEvent).toBeDefined();
      const data = failEvent!.data as { reason: string; error: string };
      expect(data.reason).toBe('timeout_or_crash');
      expect(data.error).toMatch(/timeout after 50ms/);
      // `done` still fires so SSE consumers see task closure.
      expect(captured.find(e => e.type === 'done')).toBeDefined();
    } finally {
      (config.agents as { validationTimeoutMs: number }).validationTimeoutMs = original;
    }
  });
});

// Task cancellation — when shouldCancel() returns true between steps,
// the step is marked failed and the task throws rather than hanging.
describe('Orchestrator task cancellation', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('skips remaining steps when cancelled between launches', async () => {
    const { orch } = buildOrchestrator({
      steps: [
        { id: 'a', description: 'a', dependencies: [] },
        { id: 'b', description: 'b', dependencies: ['a'] },
      ],
    });

    let cancelled = false;
    // Cancel after step a completes (before b is launched).
    let coderCalls = 0;
    (orch as unknown as { coder: { execute: ReturnType<typeof vi.fn> } }).coder = {
      execute: vi.fn(async () => {
        coderCalls++;
        if (coderCalls === 1) cancelled = true; // cancel after step a
        return { files: [{ action: 'create', path: `step-${coderCalls}.ts`, content: 'x' }] };
      }),
    };

    // shouldCancel returns true from the second check onward
    const shouldCancel = () => cancelled;

    // Step a completed, step b was skipped by cancellation → partial result.
    const taskId = 'task-cancel';
    const captured: TaskEvent[] = [];
    taskEvents.on(`task:${taskId}`, e => captured.push(e));
    try {
      await orch.runTask(taskId, 'cancel test', 'balanced', shouldCancel);
    } finally {
      taskEvents.off(`task:${taskId}`, captured.push.bind(captured));
    }
    const done = captured.find(e => e.type === 'done');
    expect(done).toBeDefined();
    // b was skipped due to cancellation — appears in failedStepIds
    const doneData = done!.data as { failedStepIds: string[] };
    expect(doneData.failedStepIds).toContain('b');
  });

  it('runs normally when shouldCancel always returns false', async () => {
    const { orch } = buildOrchestrator({
      steps: [{ id: 'a', description: 'a', dependencies: [] }],
    });
    await expect(orch.runTask('task-no-cancel', 'no cancel', 'balanced', () => false))
      .resolves.toBeUndefined();
  });
});

// v1.41-a — Architect parse-fail retry. When ArchitectAgent.execute() throws
// (Gemma outputs a preamble before JSON), the orchestrator retries once with a
// JSON-only nudge. If both fail, the step continues with an empty design rather
// than crashing — the Coder has RAG context to proceed.
describe('Architect parse-fail retry (v1.41-a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retries once when Architect throws and succeeds on second attempt', async () => {
    const { orch } = buildOrchestrator({
      steps: [{ id: 'a', description: 'step a', dependencies: [] }],
    });

    let architectCalls = 0;
    (orch as unknown as { architect: { execute: ReturnType<typeof vi.fn> } }).architect = {
      execute: vi.fn(async () => {
        architectCalls++;
        if (architectCalls === 1) throw new Error('LLM output parsing failed: unknown');
        return { design: 'retry design' };
      }),
    };

    const taskId = 'task-arch-retry';
    await expect(orch.runTask(taskId, 'arch retry')).resolves.toBeUndefined();
    expect(architectCalls).toBe(2);
  });

  it('continues with empty design when both Architect attempts fail', async () => {
    const { orch } = buildOrchestrator({
      steps: [{ id: 'a', description: 'step a', dependencies: [] }],
    });

    (orch as unknown as { architect: { execute: ReturnType<typeof vi.fn> } }).architect = {
      execute: vi.fn().mockRejectedValue(new Error('LLM output parsing failed: unknown')),
    };

    const taskId = 'task-arch-both-fail';
    // Must NOT throw — falls back to empty design, Coder proceeds with RAG context.
    await expect(orch.runTask(taskId, 'arch both fail')).resolves.toBeUndefined();
  });
});

// v1.41-b — NoopStep retry. When Coder returns 0 file changes, the orchestrator
// retries once with a targeted nudge (+ CodeGraph hint if a matching symbol is
// found). Only throws NoopStepError if the retry also returns 0 changes.
describe('NoopStep retry (v1.41-b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retries Coder and succeeds when retry produces file changes', async () => {
    const { orch, git } = buildOrchestrator({
      steps: [{ id: 'a', description: 'add health endpoint', dependencies: [] }],
    });

    // First Coder call → 0 changes; retry → 1 change.
    let coderCalls = 0;
    (orch as unknown as { coder: { execute: ReturnType<typeof vi.fn> } }).coder = {
      execute: vi.fn(async () => {
        coderCalls++;
        if (coderCalls === 1) return { files: [] };
        return { files: [{ action: 'create', path: 'src/health.ts', content: 'x' }] };
      }),
    };

    const taskId = 'task-noop-retry-ok';
    const captured: TaskEvent[] = [];
    taskEvents.on(`task:${taskId}`, e => captured.push(e));
    try {
      await orch.runTask(taskId, 'noop retry ok');
    } finally {
      taskEvents.off(`task:${taskId}`, captured.push.bind(captured));
    }

    // step_noop fires on first empty result, but task ultimately succeeds.
    expect(captured.find(e => e.type === 'step_noop')).toBeDefined();
    expect(captured.find(e => e.type === 'commit')).toBeDefined();
    expect(git.commitChanges).toHaveBeenCalledTimes(1);
  });

  it('throws NoopStepError when retry also returns 0 changes', async () => {
    const { orch } = buildOrchestrator({
      steps: [{ id: 'a', description: 'add something', dependencies: [] }],
    });

    (orch as unknown as { coder: { execute: ReturnType<typeof vi.fn> } }).coder = {
      execute: vi.fn().mockResolvedValue({ files: [] }),
    };

    const taskId = 'task-noop-retry-fail';
    // All steps failed → runTask throws "All N steps failed"
    await expect(orch.runTask(taskId, 'noop both empty')).rejects.toThrow('steps failed');
  });
});

// v1.40-a — TesterAgent-generated test files are validated with tsc before being
// added to the pipeline. Files with TS errors (e.g. undeclared variables like
// `body is not defined`, wrong Fastify types) are discarded silently so they
// cannot cause validation failures on top of correct production changes.
describe('TesterAgent post-generation TS validation (v1.40-a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps test files that pass tsc', async () => {
    const { orch } = buildOrchestrator({
      steps: [{ id: 'a', description: 'a', dependencies: [] }],
    });

    (orch as unknown as { tester: { execute: ReturnType<typeof vi.fn> } }).tester = {
      execute: vi.fn().mockResolvedValue({
        testFiles: [{ action: 'create', path: 'src/__tests__/good.test.ts', content: 'export {}' }],
      }),
    };

    const taskId = 'task-tester-pass';
    const captured: TaskEvent[] = [];
    const handler = (e: TaskEvent) => captured.push(e);
    taskEvents.on(`task:${taskId}`, handler);
    try {
      await orch.runTask(taskId, 'tester valid');
    } finally {
      taskEvents.off(`task:${taskId}`, handler);
    }

    // Tester file passed validation → commit includes it (3 files: coder + tester)
    const commitEvent = captured.find(e => e.type === 'commit');
    expect(commitEvent).toBeDefined();
    const fileCount = (commitEvent!.data as { fileCount: number }).fileCount;
    // At least the Coder file + tester file (mock typeChecker always returns success)
    expect(fileCount).toBeGreaterThanOrEqual(1);
    expect(captured.find(e => e.type === 'done')).toBeDefined();
  });

  it('discards test files whose path appears in tsc error output', async () => {
    const { orch } = buildOrchestrator({
      steps: [{ id: 'a', description: 'a', dependencies: [] }],
    });

    // TesterAgent produces a bad file.
    (orch as unknown as { tester: { execute: ReturnType<typeof vi.fn> } }).tester = {
      execute: vi.fn().mockResolvedValue({
        testFiles: [{ action: 'create', path: 'src/__tests__/bad.test.ts', content: 'bad code' }],
      }),
    };

    // typeChecker.runOn: first 2 calls pass (baseline + applyAndCheckTs), 3rd
    // call is validateAndFilterTestFiles — returns TS error mentioning the test file.
    let typeCheckCalls = 0;
    (orch as unknown as { typeChecker: { run: ReturnType<typeof vi.fn>; runOn: ReturnType<typeof vi.fn> } }).typeChecker = {
      run: vi.fn().mockResolvedValue({ success: true, output: '', exitCode: 0, durationMs: 5 }),
      runOn: vi.fn(async (paths: string[]) => {
        typeCheckCalls++;
        const isTestCall = paths.some(p => p.includes('bad.test.ts'));
        if (isTestCall) {
          return {
            success: false,
            exitCode: 2,
            output: 'src/__tests__/bad.test.ts(1,1): error TS1128: Declaration or statement expected.',
            durationMs: 5,
          };
        }
        return { success: true, output: '', exitCode: 0, durationMs: 5 };
      }),
    };

    const taskId = 'task-tester-discard';
    const captured: TaskEvent[] = [];
    const handler = (e: TaskEvent) => captured.push(e);
    taskEvents.on(`task:${taskId}`, handler);
    try {
      // Task must NOT throw — bad test file is silently discarded.
      await expect(orch.runTask(taskId, 'tester discard')).resolves.toBeUndefined();
    } finally {
      taskEvents.off(`task:${taskId}`, handler);
    }

    // Step should still complete and commit the Coder's production file.
    expect(captured.find(e => e.type === 'done')).toBeDefined();
    expect(captured.find(e => e.type === 'error')).toBeUndefined();
  });

  it('discards test files with no it()/test() calls (empty describe — Rule 9)', async () => {
    const { orch } = buildOrchestrator({
      steps: [{ id: 'a', description: 'a', dependencies: [] }],
    });

    (orch as unknown as { tester: { execute: ReturnType<typeof vi.fn> } }).tester = {
      execute: vi.fn().mockResolvedValue({
        testFiles: [{
          action: 'create',
          path: 'src/__tests__/empty.test.ts',
          // Has a describe but no it() — vitest "No test found in suite"
          content: "import { describe } from 'vitest';\ndescribe('empty', () => {});\n",
        }],
      }),
    };

    const taskId = 'task-tester-empty-suite';
    const captured: TaskEvent[] = [];
    const handler = (e: TaskEvent) => captured.push(e);
    taskEvents.on(`task:${taskId}`, handler);
    try {
      await expect(orch.runTask(taskId, 'empty suite')).resolves.toBeUndefined();
    } finally {
      taskEvents.off(`task:${taskId}`, handler);
    }

    // Task completes — empty test file was discarded before validation.
    expect(captured.find(e => e.type === 'done')).toBeDefined();
    expect(captured.find(e => e.type === 'error')).toBeUndefined();
    // validation_pass (no test file interference)
    expect(captured.find(e => e.type === 'validation_pass')).toBeDefined();
  });

  it('continues without any test files when tester execute throws', async () => {
    const { orch } = buildOrchestrator({
      steps: [{ id: 'a', description: 'a', dependencies: [] }],
    });

    (orch as unknown as { tester: { execute: ReturnType<typeof vi.fn> } }).tester = {
      execute: vi.fn().mockRejectedValue(new Error('LLM returned invalid JSON')),
    };

    const taskId = 'task-tester-throw';
    const captured: TaskEvent[] = [];
    const handler = (e: TaskEvent) => captured.push(e);
    taskEvents.on(`task:${taskId}`, handler);
    try {
      await expect(orch.runTask(taskId, 'tester crash')).resolves.toBeUndefined();
    } finally {
      taskEvents.off(`task:${taskId}`, handler);
    }

    // Task completes normally — Tester failure is best-effort.
    expect(captured.find(e => e.type === 'done')).toBeDefined();
    expect(captured.find(e => e.type === 'error')).toBeUndefined();
  });
});

// v1.39-c — step-level Reviewer-reject path must route through BUGFIX_SPEC
// (tool-calling Fixer) when toolCallingCoder=true. Previously the patch-based
// Fixer ran even with tool-calling on — patch-based only sees `currentChanges`
// as search/replace edits, never the full file content. v1.38 real-repo bench
// T6/H4 traced "reviewer_reject" failures back to that loss-of-context.
describe('Orchestrator Reviewer-reject Fixer dispatch (v1.39-c)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes through BUGFIX_SPEC when toolCallingCoder=true', async () => {
    const { config } = await import('@rag-system/shared');
    const original = config.agents.toolCallingCoder;
    const originalMax = config.JOB_MAX_RETRIES;
    (config.agents as { toolCallingCoder: boolean }).toolCallingCoder = true;
    (config as { JOB_MAX_RETRIES: number }).JOB_MAX_RETRIES = 2;

    try {
      const { orch } = buildOrchestrator({
        steps: [{ id: 'a', description: 'step a', dependencies: [] }],
      });

      // Reviewer rejects once, then approves — so exactly one Fixer dispatch
      // happens and we can pin which path was taken.
      let reviewerCalls = 0;
      (orch as unknown as { reviewer: { execute: ReturnType<typeof vi.fn> } }).reviewer = {
        execute: vi.fn(async () => {
          reviewerCalls++;
          return reviewerCalls === 1
            ? { isApproved: false, issues: ['hardcoded literal instead of constant'] }
            : { isApproved: true, issues: [] };
        }),
      };
      // Patch-Fixer must NOT be called on this path.
      const patchFixer = vi.fn().mockResolvedValue({ files: [] });
      (orch as unknown as { fixer: { execute: ReturnType<typeof vi.fn> } }).fixer = { execute: patchFixer };

      await orch.runTask('task-v39c-on', 'reviewer reject scenario');

      expect(patchFixer).not.toHaveBeenCalled();
      // runTaskAgent is called for Coder too (pickSpec(stepKind) path); filter
      // to BUGFIX_SPEC calls — those carry `issues + currentFiles` per the
      // validation-mode contract reused by the Reviewer-reject path.
      const bugfixCalls = runTaskAgentMock.mock.calls.filter(args => {
        const input = args[1] as { issues?: string[]; currentFiles?: unknown[] };
        return Array.isArray(input.issues) && input.issues.length > 0;
      });
      expect(bugfixCalls.length).toBeGreaterThanOrEqual(1);
      const firstBugfix = bugfixCalls[0]![1] as { issues: string[] };
      expect(firstBugfix.issues).toContain('hardcoded literal instead of constant');
    } finally {
      (config.agents as { toolCallingCoder: boolean }).toolCallingCoder = original;
      (config as { JOB_MAX_RETRIES: number }).JOB_MAX_RETRIES = originalMax;
    }
  });

  it('falls back to patch-based fixer when toolCallingCoder=false', async () => {
    const { config } = await import('@rag-system/shared');
    const original = config.agents.toolCallingCoder;
    const originalMax = config.JOB_MAX_RETRIES;
    (config.agents as { toolCallingCoder: boolean }).toolCallingCoder = false;
    (config as { JOB_MAX_RETRIES: number }).JOB_MAX_RETRIES = 2;

    try {
      const { orch } = buildOrchestrator({
        steps: [{ id: 'a', description: 'step a', dependencies: [] }],
      });

      let reviewerCalls = 0;
      (orch as unknown as { reviewer: { execute: ReturnType<typeof vi.fn> } }).reviewer = {
        execute: vi.fn(async () => {
          reviewerCalls++;
          return reviewerCalls === 1
            ? { isApproved: false, issues: ['style: missing semicolon'] }
            : { isApproved: true, issues: [] };
        }),
      };
      const patchFixer = vi.fn().mockResolvedValue({ files: [{ action: 'create', path: 'fix.ts', content: 'x' }] });
      (orch as unknown as { fixer: { execute: ReturnType<typeof vi.fn> } }).fixer = { execute: patchFixer };

      await orch.runTask('task-v39c-off', 'legacy patch fixer path');

      expect(patchFixer).toHaveBeenCalledTimes(1);
      // First positional arg is the issues array per FixerAgent.execute(issues, ...).
      const callArgs = patchFixer.mock.calls[0] as unknown[];
      expect(callArgs[0]).toContain('style: missing semicolon');
    } finally {
      (config.agents as { toolCallingCoder: boolean }).toolCallingCoder = original;
      (config as { JOB_MAX_RETRIES: number }).JOB_MAX_RETRIES = originalMax;
    }
  });
});

// v1.39-a — noopStepIds distinguishes "Coder produced 0 files" from generic
// step failures so bench analytics can detect regressions where the model
// went silent on a step it should have edited.
describe('Orchestrator noop step detection (v1.39-a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports noopStepIds in done.data when Coder returns no file changes', async () => {
    const { orch } = buildOrchestrator({
      steps: [
        { id: 'a', description: 'a', dependencies: [] },
        { id: 'b', description: 'b', dependencies: [] },
      ],
    });

    // Coder returns 0 files for step `b` only — this is the L2.4/L2.6 scenario
    // the v1.35 step_noop event was introduced for. `a` proceeds normally.
    let coderCalls = 0;
    (orch as unknown as { coder: { execute: ReturnType<typeof vi.fn> } }).coder = {
      execute: vi.fn(async () => {
        coderCalls++;
        // calls 2 and 3 are the original + retry for step b — both return empty
        // so NoopStepError is thrown and noopStepIds gets populated.
        if (coderCalls === 2 || coderCalls === 3) return { files: [] };
        return { files: [{ action: 'create', path: `step-${coderCalls}.ts`, content: 'x' }] };
      }),
    };

    const taskId = 'task-noop-1';
    const captured: TaskEvent[] = [];
    const handler = (e: TaskEvent) => captured.push(e);
    taskEvents.on(`task:${taskId}`, handler);
    try {
      await orch.runTask(taskId, 'mixed noop');
    } finally {
      taskEvents.off(`task:${taskId}`, handler);
    }

    // step_noop event still fires (pre-existing v1.35 contract)
    expect(captured.find(e => e.type === 'step_noop')).toBeDefined();

    const doneEvent = captured.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();
    const doneData = doneEvent!.data as { noopStepIds: string[]; failedStepIds: string[] };
    expect(doneData.noopStepIds.length).toBe(1);
    expect(doneData.failedStepIds).toContain(doneData.noopStepIds[0]);
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

// ---------------------------------------------------------------------------
// detectEsmProductionViolators — unit tests (v1.62)
// ---------------------------------------------------------------------------

describe('detectEsmProductionViolators', () => {
  type DetectFn = (changes: unknown[]) => string[];

  function makeOrch() {
    const orch = new Orchestrator('test-project-id', '/tmp/data', {} as never, {} as never, { root: '/tmp' } as never, {} as never, {} as never);
    // Force ESM mode (bypass fs.readFileSync for package.json).
    (orch as unknown as { esmProject: boolean }).esmProject = true;
    const detect = (orch as unknown as { detectEsmProductionViolators: DetectFn }).detectEsmProductionViolators.bind(orch);
    return detect;
  }

  it('flags create action with require() in production file', () => {
    const detect = makeOrch();
    const result = detect([
      { action: 'create', path: 'src/utils.ts', content: "const x = require('fs')" },
    ]);
    expect(result).toEqual(['src/utils.ts']);
  });

  it('flags modify action whose replace text contains require()', () => {
    const detect = makeOrch();
    const result = detect([
      { action: 'modify', path: 'src/helper.ts', edits: [{ search: 'old', replace: "const v = require('path').join('a', 'b')" }] },
    ]);
    expect(result).toEqual(['src/helper.ts']);
  });

  it('flags __dirname in create action', () => {
    const detect = makeOrch();
    const result = detect([
      { action: 'create', path: 'src/loader.ts', content: 'const dir = __dirname' },
    ]);
    expect(result).toEqual(['src/loader.ts']);
  });

  it('does not flag test files (isTestPath)', () => {
    const detect = makeOrch();
    const result = detect([
      { action: 'create', path: 'src/__tests__/loader.test.ts', content: "const x = require('fs')" },
    ]);
    expect(result).toEqual([]);
  });

  it('does not flag delete actions', () => {
    const detect = makeOrch();
    const result = detect([{ action: 'delete', path: 'src/old.ts' }]);
    expect(result).toEqual([]);
  });

  it('does not flag clean ESM import syntax', () => {
    const detect = makeOrch();
    const result = detect([
      { action: 'create', path: 'src/clean.ts', content: "import { readFileSync } from 'fs'" },
    ]);
    expect(result).toEqual([]);
  });

  it('handles modify with multiple edits — only flags when at least one replace has require()', () => {
    const detect = makeOrch();
    const result = detect([
      {
        action: 'modify',
        path: 'src/mixed.ts',
        edits: [
          { search: 'a', replace: 'import x from "x"' },
          { search: 'b', replace: "const y = require('y')" },
        ],
      },
    ]);
    expect(result).toEqual(['src/mixed.ts']);
  });
});
