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
  TypeChecker: class { run = vi.fn().mockResolvedValue({ success: true, output: '', exitCode: 0, durationMs: 0, skipped: 'mock' }); },
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
    commitChanges: vi.fn().mockResolvedValue(undefined),
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

    // Force a typecheck failure so the validation loop actually runs Fixer.
    // First call fails; subsequent calls pass to give the loop a way to exit
    // cleanly if the Fixer write IS swallowed.
    let typeCheckCalls = 0;
    (orch as unknown as { typeChecker: { run: ReturnType<typeof vi.fn> } }).typeChecker = {
      run: vi.fn(async () => {
        typeCheckCalls++;
        return typeCheckCalls === 1
          ? { success: false, output: 'TS2304: Cannot find name X', exitCode: 2, durationMs: 5 }
          : { success: false, output: 'TS2304: Cannot find name X', exitCode: 2, durationMs: 5 };
      }),
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
});
