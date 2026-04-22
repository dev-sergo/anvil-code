import { describe, it, expect, beforeEach, vi } from 'vitest';

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
  SafeWriter: class { execute = vi.fn(); },
  TestRunner: class { run = vi.fn().mockResolvedValue({ success: true, output: '', exitCode: 0, durationMs: 0, skipped: 'mock' }); },
  TypeChecker: class { run = vi.fn().mockResolvedValue({ success: true, output: '', exitCode: 0, durationMs: 0, skipped: 'mock' }); },
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
  const retriever = { retrieveContext: vi.fn().mockResolvedValue('') };
  const writer = { execute: vi.fn() };
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
    execute: vi.fn().mockResolvedValue({ files: [{ path: 'foo.ts', content: 'x', action: 'create' }] }),
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
});
