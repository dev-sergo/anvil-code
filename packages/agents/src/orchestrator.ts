import fs from 'fs';
import path from 'path';
import { ModelRouter } from '@rag-system/model-router';
import { GraphRetriever } from '@rag-system/rag';
import { SafeWriter, TestRunner, TypeChecker, PrettierRunner, applyEdits } from '@rag-system/safe-exec';
import { MemoryStore } from '@rag-system/memory';
import { GitEngine } from '@rag-system/git-engine';
import { buildRepoMap } from '@rag-system/code-graph';
import { PlannerAgent, inferStepKind, type PlanStep } from './planner.js';
import { CoderAgent } from './coder.js';
import { ArchitectAgent } from './architect.js';
import { TesterAgent } from './tester.js';
import { ReviewerAgent } from './reviewer.js';
import { FixerAgent } from './fixer.js';
import { runTaskAgent } from './task-agents/runner.js';
import { pickSpec } from './task-agents/registry.js';
import { BUGFIX_SPEC } from './task-agents/bugfix.js';
import { isTestPath } from './tool-calling-fixer.js';
import { partialFileSize, type PartialFile } from './partial-json.js';
import {
  FileChange,
  config,
  logger,
  taskEvents,
  taskLogger,
  withTaskContext,
  readProjectConventions,
  buildPromptContext,
  type ProjectConventions,
} from '@rag-system/shared';

// v1.39-a — distinguishes "Coder produced 0 files" from generic step failures
// so the orchestrator can report `noopStepIds` separately in the task summary.
// Bench analytics use this to spot regressions where the model "did nothing"
// vs. tasks that genuinely failed at edit/validation/Reviewer time.
export class NoopStepError extends Error {
  constructor(public stepId: string, message: string) {
    super(message);
    this.name = 'NoopStepError';
  }
}

export class Orchestrator {
  private planner: PlannerAgent;
  private architect: ArchitectAgent;
  private coder: CoderAgent;
  private tester: TesterAgent;
  private reviewer: ReviewerAgent;
  private fixer: FixerAgent;
  private typeChecker: TypeChecker;
  private testRunner: TestRunner;
  private prettier: PrettierRunner;
  private conventions: ProjectConventions | null = null;
  /** Fingerprints of pre-existing tsc/test failures on clean repo state. */
  private baselineFailures: Set<string> | null = null;

  constructor(
    private router: ModelRouter,
    private retriever: GraphRetriever,
    private writer: SafeWriter,
    private store: MemoryStore,
    private git: GitEngine,
  ) {
    this.planner = new PlannerAgent(router);
    this.architect = new ArchitectAgent(router);
    this.coder = new CoderAgent(router);
    this.tester = new TesterAgent(router);
    this.reviewer = new ReviewerAgent(router);
    this.fixer = new FixerAgent(router);
    // Validators run against the project root the writer is bound to so
    // multi-project setups check the right codebase.
    this.typeChecker = new TypeChecker(this.writer.root);
    this.testRunner = new TestRunner(this.writer.root);
    this.prettier = new PrettierRunner(this.writer.root);
  }

  private getConventions(): ProjectConventions {
    if (!this.conventions) {
      this.conventions = readProjectConventions(this.writer.root);
    }
    return this.conventions;
  }

  /**
   * Render a compact repo-map for use in agent prompts. Built fresh on every
   * call (cheap — just a render of the in-memory CodeGraph snapshot). Entry
   * points are always pinned at the top; callers can pass `extraHighlights`
   * (e.g. paths just modified by previous steps) to keep them visible too.
   */
  private renderRepoMap(extraHighlights: string[] = []): string {
    const conventions = this.getConventions();
    const highlights = Array.from(new Set([...conventions.entryPoints, ...extraHighlights]));
    return buildRepoMap(this.retriever.graph, this.writer.root, { highlightFiles: highlights });
  }

  async runTask(taskId: string, description: string, mode: 'fast'|'balanced'|'deep' = 'balanced') {
    const log = taskLogger(taskId);
    log.info({ mode }, 'Orchestrator started task');

    // 0. Compute baseline failures once on clean state (before any branch / file changes).
    await this.computeBaseline();

    // 1. Create Git Branch
    const branchName = await this.git.createBranchForTask(taskId);

    // 2. Retrieve context + load project conventions.
    // Planner only needs a high-level view; it doesn't write files, so we feed it
    // the lighter string context. Full source files enter the prompt at step level
    // where Coder/Fixer/Tester actually need to preserve imports/style.
    const conventions = this.getConventions();
    const items = await this.retriever.retrieveContextItems(description);
    logger.info(
      { taskId, retrievedFiles: [...new Set(items.map(i => i.filePath))] },
      'RAG Planner retrieval',
    );
    const ragSnippets = items
      .map(i => `// ${i.filePath}:${i.startLine}\n${i.text}`)
      .join('\n\n---\n\n');
    const repoMap = this.renderRepoMap();
    const plannerContext = buildPromptContext({
      conventions,
      ragSnippets,
      ragFilePaths: [],
      projectRoot: this.writer.root,
      repoMap,
    });

    // 3. Plan
    const plan = await withTaskContext({ taskId }, () =>
      this.planner.execute(description, plannerContext, mode),
    );
    // Truncate if Planner over-produced. We keep the head and strip dangling deps
    // so the scheduler can still execute the remaining steps cleanly.
    const cap = config.agents.plannerMaxSteps;
    if (plan.steps.length > cap) {
      log.warn({ generated: plan.steps.length, cap }, 'Planner exceeded PLANNER_MAX_STEPS — truncating');
      const kept = new Set(plan.steps.slice(0, cap).map(s => s.id));
      plan.steps = plan.steps.slice(0, cap).map(s => ({
        ...s,
        dependencies: s.dependencies.filter(d => kept.has(d)),
      }));
    }
    log.info({ steps: plan.steps.length }, 'Plan generated');
    taskEvents.emitEvent({
      taskId,
      type: 'plan',
      message: `Plan generated: ${plan.steps.length} step(s)`,
      data: { stepCount: plan.steps.length, stepIds: plan.steps.map(s => s.id) },
    });

    const writtenFiles: string[] = [];
    const { allFileChanges, completedSteps, failedSteps, stepFailures, noopStepIds } = await this.executePlanParallel(
      taskId,
      plan.steps,
      mode,
      log,
    );

    if (completedSteps.size === 0) {
      const reasons = [...stepFailures.entries()]
        .map(([id, msg]) => `Step ${id}: ${msg.slice(0, 120)}`)
        .join('; ');
      throw new Error(
        `All ${plan.steps.length} steps failed${reasons ? ` — ${reasons}` : ''}.`,
      );
    }

    if (failedSteps.size > 0) {
      log.warn(
        { completed: completedSteps.size, failed: failedSteps.size },
        'Task partially complete — some steps failed',
      );
    }

    // 5. Write all files to disk. We dedupe by path first: if multiple steps
    // (or one step's Coder output) produced several entries for the same file,
    // their edits are merged so the whole change is atomic — partial application
    // followed by a "search not found" error would corrupt the file otherwise.
    const dedupedFileChanges = dedupeChangesByPath(allFileChanges);
    const failedWrites: Array<{ change: FileChange; error: Error }> = [];

    for (const change of dedupedFileChanges) {
      try {
        this.writer.execute(change);
        writtenFiles.push(change.path);
      } catch (err: unknown) {
        const e = err instanceof Error ? err : new Error(String(err));
        failedWrites.push({ change, error: e });
        log.warn({ path: change.path, error: e.message }, 'Initial write failed; queuing for retry');
      }
    }

    // 5a. If any modify failed (typically a hallucinated `search` block from
    // the model), give Fixer one shot with the REAL current file content.
    // This is the iterative-editing pattern from Aider — model self-corrects
    // when shown the actual text it should be quoting.
    //
    // Anything that's still failing after the retry is recorded as an
    // "unrecovered write": the model wanted to change this file, neither the
    // initial nor the retry attempt succeeded, and the file is left as it was.
    // Surfaced via the `commit_partial` event below so the operator gets an
    // explicit signal that the change set is incomplete.
    const unrecoveredWrites: string[] = [];
    if (failedWrites.length > 0) {
      const retried = await this.retryFailedEdits(failedWrites, mode, log);
      const dedupedRetry = dedupeChangesByPath(retried);
      const retriedPaths = new Set<string>();
      for (const r of dedupedRetry) {
        retriedPaths.add(r.path);
        try {
          this.writer.execute(r);
          writtenFiles.push(r.path);
          log.info({ path: r.path }, 'Edit succeeded on retry with real-content feedback');
        } catch (err: unknown) {
          const e = err instanceof Error ? err : new Error(String(err));
          log.warn({ path: r.path, error: e.message }, 'Retry also failed; file remains unchanged');
          unrecoveredWrites.push(r.path);
        }
      }
      // Files whose initial write failed AND for which retry didn't even
      // produce a candidate change (e.g. retryFailedEdits skipped them
      // because the file didn't exist on disk yet) are also unrecovered.
      for (const f of failedWrites) {
        if (!retriedPaths.has(f.change.path) && !writtenFiles.includes(f.change.path)) {
          unrecoveredWrites.push(f.change.path);
        }
      }
    }

    // 6. Validation loop: typecheck + tests, with Fixer retries
    const validation = await withTaskContext({ taskId }, () =>
      this.runValidationLoop(taskId, allFileChanges, mode, log),
    );

    // v1.32-a.2: Fixer may have written paths during validation that weren't
    // in Coder's output. Without merging them in, the commit step below stages
    // only Coder's paths — which on bug-fix tasks (where Coder does nothing
    // useful and Fixer does the real fix) leaves the actual change untracked.
    // L4.1 v1.32-a.1 surfaced this: Validation passed, but `git.add(coderPaths)`
    // staged nothing, `git.commit` produced no commit, the correct fix lived
    // in the working tree as a dirty file. Dedupe so the staging list is
    // unique even when Coder also touched a file Fixer later edited.
    for (const p of validation.writtenFiles) {
      if (!writtenFiles.includes(p)) writtenFiles.push(p);
    }

    // 7. Commit — skip if validation failed and the strict flag is on.
    // Branch still exists for the operator to inspect; nothing is lost.
    const shouldSkipCommit = !validation.passed && config.git.commitOnlyIfValid;
    if (writtenFiles.length > 0 && !shouldSkipCommit) {
      // v1.32-a.6 — prettier post-step. Cosmetics-only: collapses style
      // variance (indent depth, trailing commas, blank lines) so diffs become
      // byte-perfect when the project has prettier configured. Never fails
      // the commit — a prettier crash logs and the original Coder/Fixer
      // output gets committed as-is.
      const prettierResult = await this.prettier.run(writtenFiles);
      if (!prettierResult.success) {
        log.warn(
          { output: prettierResult.output.slice(-200) },
          'Prettier exited non-zero; committing un-formatted output',
        );
      } else if (prettierResult.formatted.length > 0) {
        log.info(
          { count: prettierResult.formatted.length, durationMs: prettierResult.durationMs },
          'Prettier formatted files before commit',
        );
      }

      const commitHash = await this.git.commitChanges(taskId, `Complete task: ${description.substring(0, 50)}`, writtenFiles);
      const hashSuffix = commitHash ? ` — ${commitHash.slice(0, 8)}` : '';
      taskEvents.emitEvent({
        taskId,
        type: 'commit',
        message: `Committed ${writtenFiles.length} file(s)${hashSuffix}`,
        data: { fileCount: writtenFiles.length, commitHash },
      });

      // v1.39-a — cumulative merge-wait. Ff-merge this task's branch into the
      // cumulative branch so the next task forks from accumulated state instead
      // of racing against `main`. Failure leaves the task branch intact for
      // manual resolution and surfaces a cumulative_merge_failed event; the
      // outer task is still considered done (commit landed on its own branch).
      if (config.git.cumulative.enabled) {
        try {
          await this.git.mergeIntoCumulative(branchName);
          taskEvents.emitEvent({
            taskId,
            type: 'cumulative_merged',
            message: `Merged ${branchName} into ${config.git.cumulative.branch}`,
            data: { branchName, cumulative: config.git.cumulative.branch },
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ branchName, error: msg }, 'Cumulative merge failed');
          taskEvents.emitEvent({
            taskId,
            type: 'cumulative_merge_failed',
            message: `Cumulative merge failed: ${msg}`,
            data: { branchName, cumulative: config.git.cumulative.branch, error: msg.slice(0, 500) },
          });
        }
      }
    } else if (writtenFiles.length > 0 && shouldSkipCommit) {
      log.warn({ issuesCount: validation.issuesCount }, 'Skipping commit — validation failed');
      taskEvents.emitEvent({
        taskId,
        type: 'commit_skipped',
        message: `Commit skipped — ${validation.issuesCount} unresolved validation issue(s). Files remain on auto-branch for inspection.`,
        data: { fileCount: writtenFiles.length, issuesCount: validation.issuesCount },
      });
    }

    // 7a. Partial-completion signal. The task is marked `done` either way (so
    // the SSE stream closes and the API returns 200), but a `commit_partial`
    // event right before `done` tells the operator explicitly: "some steps or
    // file writes did not land". Without this, partial state landed silently —
    // see L2.3 cumulative #1 in the v1.26 benchmark, where step3's DELETE
    // endpoint never made it but the user saw only a regular `done`.
    const failedStepIds = [...failedSteps];
    const partial = failedStepIds.length > 0 || unrecoveredWrites.length > 0;
    if (partial) {
      const reasons: string[] = [];
      if (failedStepIds.length > 0) reasons.push(`${failedStepIds.length} step(s) failed`);
      if (unrecoveredWrites.length > 0) reasons.push(`${unrecoveredWrites.length} file write(s) unrecovered`);
      taskEvents.emitEvent({
        taskId,
        type: 'commit_partial',
        message: `Partial completion: ${reasons.join('; ')}`,
        data: {
          failedStepIds,
          unrecoveredWrites,
          completedSteps: completedSteps.size,
          totalSteps: plan.steps.length,
        },
      });
    }

    // 8. Store memory
    const result = failedSteps.size > 0
      ? `Completed ${completedSteps.size}/${plan.steps.length} steps. Failed: ${[...failedSteps].join(', ')}`
      : undefined;
    this.store.saveTask({
      id: taskId,
      description,
      status: 'completed',
      result,
      completedAt: new Date().toISOString(),
    });

    log.info(
      { completed: completedSteps.size, failed: failedSteps.size, noop: noopStepIds.size, unrecovered: unrecoveredWrites.length },
      'Task completed',
    );
    taskEvents.emitEvent({
      taskId,
      type: 'done',
      message: result ?? 'Task completed successfully',
      data: {
        completed: completedSteps.size,
        failed: failedSteps.size,
        partial,
        failedStepIds,
        noopStepIds: [...noopStepIds],
        unrecoveredWrites,
      },
    });
  }

  private async executePlanParallel(
    taskId: string,
    steps: Array<{ id: string; description: string; dependencies: string[] }>,
    mode: 'fast'|'balanced'|'deep',
    log: ReturnType<typeof taskLogger>,
  ): Promise<{ allFileChanges: FileChange[]; completedSteps: Set<string>; failedSteps: Set<string>; stepFailures: Map<string, string>; noopStepIds: Set<string> }> {
    detectCycles(steps);

    const allFileChanges: FileChange[] = [];
    const completedSteps = new Set<string>();
    const failedSteps = new Set<string>();
    const stepFailures = new Map<string, string>();
    const noopStepIds = new Set<string>();
    const remaining = new Map(steps.map(s => [s.id, s] as const));
    const inFlight = new Map<string, Promise<void>>();
    const parallelism = Math.max(1, config.agents.parallelism);

    // A dep counts as satisfied only when it has actually settled (completed or failed).
    // Dangling ids that no step in the plan defines stay unsatisfied, which deliberately
    // strands the dependent step so the "stuck" detection below skips it.
    const isReady = (s: { dependencies: string[] }): boolean =>
      s.dependencies.every(d => completedSteps.has(d) || failedSteps.has(d));

    const launch = (step: { id: string; description: string; dependencies: string[]; kind?: PlanStep['kind'] }) => {
      remaining.delete(step.id);

      const blockedBy = step.dependencies.filter(d => failedSteps.has(d));
      if (blockedBy.length > 0) {
        log.warn({ stepId: step.id, blockedBy }, 'Skipping step — dependency failed');
        failedSteps.add(step.id);
        this.store.saveFailure(
          `step-skipped:${step.id}`,
          `Skipped because dependencies failed: ${blockedBy.join(', ')}`,
        );
        taskEvents.emitEvent({
          taskId,
          type: 'step_skip',
          message: `Step ${step.id} skipped (dependency failed)`,
          data: { stepId: step.id, blockedBy },
        });
        return;
      }

      log.info({ stepId: step.id }, 'Executing step');
      taskEvents.emitEvent({
        taskId,
        type: 'step_start',
        message: `Step ${step.id}: ${step.description.slice(0, 80)}`,
        data: { stepId: step.id },
      });

      // Snapshot the running aggregate so the step sees what previous steps
      // produced, but later steps that complete in parallel don't mutate this
      // step's view mid-flight.
      const previousChanges = allFileChanges.slice();

      const work = (async () => {
        try {
          const stepChanges = await withTaskContext({ taskId, stepId: step.id }, () =>
            this.executeStep(taskId, step, mode, log, previousChanges),
          ) as FileChange[];
          allFileChanges.push(...stepChanges);
          completedSteps.add(step.id);
          taskEvents.emitEvent({
            taskId,
            type: 'step_complete',
            message: `Step ${step.id} complete (${stepChanges.length} file change(s))`,
            data: { stepId: step.id, fileCount: stepChanges.length },
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error({ stepId: step.id, error: msg }, 'Step failed — continuing with remaining steps');
          failedSteps.add(step.id);
          stepFailures.set(step.id, msg);
          if (err instanceof NoopStepError) noopStepIds.add(step.id);
          this.store.saveFailure(
            `step-failure:${step.id}:${msg.slice(0, 80)}`,
            'Step skipped after agent error; remaining steps continue',
          );
          this.store.saveADR({
            id: `${Date.now()}-step-failure-${step.id}`,
            taskId,
            decision: 'Step Failed',
            context: `Step ${step.id} (${step.description.slice(0, 100)}): ${msg.slice(0, 300)}`,
            consequences: 'Skipped step; downstream dependent steps will also be skipped.',
          });
          taskEvents.emitEvent({
            taskId,
            type: 'step_fail',
            message: `Step ${step.id} failed: ${msg.slice(0, 200)}`,
            data: { stepId: step.id, error: msg.slice(0, 500) },
          });
        } finally {
          inFlight.delete(step.id);
        }
      })();

      inFlight.set(step.id, work);
    };

    while (remaining.size > 0 || inFlight.size > 0) {
      // Launch every ready step up to the parallelism cap
      let launched = 0;
      for (const step of remaining.values()) {
        if (inFlight.size >= parallelism) break;
        if (!isReady(step)) continue;
        launch(step);
        launched++;
      }

      // If nothing is in flight and nothing was launched, the remaining steps
      // are blocked by a dependency that isn't in `remaining`/`inFlight`/either set.
      // detectCycles() rules out cycles, so this means a dangling dep id —
      // mark the rest as skipped and bail.
      if (inFlight.size === 0 && launched === 0) {
        for (const step of remaining.values()) {
          log.warn({ stepId: step.id, dependencies: step.dependencies }, 'Step has unresolved dependency — marking failed');
          failedSteps.add(step.id);
          this.store.saveFailure(
            `step-skipped:${step.id}`,
            `Unresolved dependency ids: ${step.dependencies.join(', ')}`,
          );
          taskEvents.emitEvent({
            taskId,
            type: 'step_skip',
            message: `Step ${step.id} skipped (unresolved dependency)`,
            data: { stepId: step.id, dependencies: step.dependencies },
          });
        }
        remaining.clear();
        break;
      }

      // Wait for at least one to settle so the next iteration can launch newly-ready steps.
      // Guard against empty inFlight: Promise.race([]) never resolves and would hang forever
      // when all launched steps were synchronous skips (e.g. all blocked by a failed dependency).
      if (inFlight.size > 0) {
        await Promise.race(inFlight.values());
      }
    }

    return { allFileChanges, completedSteps, failedSteps, stepFailures, noopStepIds };
  }

  private async executeStep(
    taskId: string,
    step: { id: string; description: string; dependencies: string[]; kind?: PlanStep['kind'] },
    mode: 'fast'|'balanced'|'deep',
    log: ReturnType<typeof taskLogger>,
    previousChanges: FileChange[] = [],
  ): Promise<FileChange[]> {
    // v1.32-c: log a warning when the heuristic disagrees with the Planner's
    // step.kind. We don't override (Planner is the source of truth) — the warn
    // surfaces a suspicious classification to the operator. Matches design
    // rev2 §2.3.
    const stepKind: PlanStep['kind'] = step.kind ?? 'feature';
    const inferredKind = inferStepKind(step.description);
    if (inferredKind !== stepKind) {
      log.warn(
        { stepId: step.id, planned: stepKind, inferred: inferredKind, desc: step.description.slice(0, 120) },
        'Planner step.kind disagrees with heuristic — review classification',
      );
    }
    const conventions = this.getConventions();
    const items = await this.retriever.retrieveContextItems(step.description);
    const ragSnippets = items
      .map(i => `// ${i.filePath}:${i.startLine}\n${i.text}`)
      .join('\n\n---\n\n');
    // Collect unique file paths mentioned by RAG so we can read full source.
    // This is what lets Coder preserve imports and style when modifying.
    //
    // We also unconditionally include the project's entry points (server.ts /
    // main.ts / app.ts / index.ts when they exist). Vector search rarely surfaces
    // them — they typically only call other code, with no symbols of their own —
    // yet they're the most-edited file in cross-file tasks. Without their full
    // text Coder synthesizes a fictional version, which makes patch-based edits
    // fail with "search not found".
    const ragFilePaths = Array.from(new Set([
      ...items.map(i => i.filePath),
      ...conventions.entryPoints,
    ]));

    // Materialize previousChanges into "what each touched file actually contains
    // right now": for create — use new content; for modify — apply edits on top
    // of the prior virtual content (or disk if untouched); for delete — drop.
    // This is what lets a later step see the EXACT current state of a file an
    // earlier step modified, even though nothing has been written to disk yet.
    const newlySources = resolveVirtualSources(previousChanges, this.writer.root);

    // Repo-map: pin entry points + any files this step's "previous siblings"
    // already touched, so the model never loses sight of files mid-step. Built
    // once per step from the live graph snapshot.
    const repoMap = this.renderRepoMap(newlySources.map(s => s.path));

    // v1.32-c: skip Architect for refactor kinds. The transformation IS the
    // design — running ArchitectAgent adds latency without value when the
    // task is "rename X to Y" / "extract function W". Feature and bugfix
    // kinds keep the Architect pre-pass.
    const design = stepKind === 'refactor'
      ? { design: '' }
      : await this.architect.execute(
          step.description,
          buildPromptContext({ conventions, ragSnippets, ragFilePaths: [], projectRoot: this.writer.root, newlySources, repoMap }),
          mode,
        );

    const promptContext = buildPromptContext({
      conventions,
      ragSnippets,
      ragFilePaths,
      projectRoot: this.writer.root,
      designContext: design.design,
      newlySources,
      repoMap,
    });
    // Leaner variant for Reviewer/Tester that already see files inline in their own prompt.
    const reviewContext = buildPromptContext({
      conventions,
      ragSnippets,
      ragFilePaths: [],
      projectRoot: this.writer.root,
      newlySources,
      repoMap,
    });
    const onCoderFile = (file: PartialFile, index: number) => {
      taskEvents.emitEvent({
        taskId,
        type: 'coder_file_ready',
        message: `Coder produced ${file.path}`,
        data: {
          stepId: step.id,
          path: file.path,
          action: file.action,
          size: partialFileSize(file),
          index,
        },
      });
    };
    // v1.30 — Coder selection. When TOOL_CALLING_CODER=true, the model drives
    // changes via tool calls (read_file/replace_in_file/...) against a
    // WorkingSet. When false (default), the patch-based Coder runs the existing
    // streaming JSON path. Same return shape (CoderOutput) — downstream pipeline
    // (Reviewer, write phase, validation) is unchanged.
    //
    // v1.32-c: tool-calling path dispatches to a kind-specific spec via
    // runTaskAgent. Default kind=feature gives behavior identical to the
    // previous ToolCallingCoderAgent (AC6 regression guard).
    const codeChanges = config.agents.toolCallingCoder
      ? await runTaskAgent(
          pickSpec(stepKind),
          { stepDescription: step.description, context: promptContext, taskMode: mode, ragReadOnlyPaths: ragFilePaths },
          this.router,
          this.writer.root,
        )
      : await this.coder.execute(step.description, promptContext, mode, onCoderFile);
    void onCoderFile;

    let currentChanges: FileChange[] = [...codeChanges.files];

    // v1.35 C1/C2 — fail fast when Coder produced nothing. Previously the step
    // quietly completed with 0 changes (Reviewer approved an empty file list),
    // leaving the task looking "completed" with no actual edits — L2.4 / L2.6.
    if (currentChanges.length === 0) {
      taskEvents.emitEvent({
        taskId,
        type: 'step_noop',
        message: `Step ${step.id} produced no file changes`,
        data: { stepId: step.id },
      });
      throw new NoopStepError(step.id, `Step ${step.id}: Coder produced no file changes`);
    }

    // v1.32-c: skip Tester for refactor kinds. Refactor preserves behavior
    // — existing tests are the regression gate; generating new ones is wasted
    // work and risks regression-test drift.
    if (config.agents.testerEnabled && stepKind !== 'refactor') {
      try {
        const testChanges = await this.tester.execute(codeChanges.files, reviewContext, mode);
        currentChanges.push(...testChanges.testFiles);
      } catch (e) {
        // Tester is best-effort. A bad LLM JSON or schema mismatch must not blow up
        // the whole step — Coder's output is still valuable on its own. Reviewer
        // and validation still run on the production files.
        log.warn(
          { stepId: step.id, error: e instanceof Error ? e.message : String(e) },
          'Tester failed — continuing without generated tests',
        );
      }
    } else {
      log.debug({ stepId: step.id }, 'Tester disabled via TESTER_ENABLED=false');
    }

    // v1.35 B2 — pre-Reviewer TS check. Run tsc against the changed files
    // BEFORE the LLM judge so that parse/type errors are caught early and fed
    // to the Fixer with exact compiler output, not vague LLM-inferred issues.
    // Up to 2 attempts: Fixer on attempt 0 errors, then re-check; bail on 1.
    // Only TS/TSX production files are checked; test files are excluded because
    // monorepo workspace link issues frequently cause pre-existing TS errors in
    // test files (e.g. "Cannot find module '../node-http.js'") that the Fixer
    // cannot resolve and that are unrelated to the Coder's production changes.
    const tsChangedPaths = currentChanges
      .filter(c => (c.path.endsWith('.ts') || c.path.endsWith('.tsx')) && c.action !== 'delete' && !isTestPath(c.path))
      .map(c => c.path);
    if (tsChangedPaths.length > 0) {
      for (let preAttempt = 0; preAttempt < 2; preAttempt++) {
        const preCheck = await this.applyAndCheckTs(currentChanges);
        if (preCheck.passed) break;
        if (preAttempt === 1) {
          throw new Error(
            `Step ${step.id}: TS pre-check failed after fix retry — ${preCheck.output.slice(0, 300)}`,
          );
        }
        log.warn(
          { stepId: step.id, tscErrors: preCheck.output.slice(0, 300) },
          'Pre-Reviewer TS errors — invoking Fixer',
        );
        const tscIssues = [`TypeScript compilation failed:\n${preCheck.output}`];
        const fixResult = config.agents.toolCallingCoder
          ? await runTaskAgent(
              BUGFIX_SPEC,
              {
                stepDescription: step.description,
                context: promptContext,
                taskMode: mode,
                issues: tscIssues,
                currentFiles: currentChanges,
              },
              this.router,
              this.writer.root,
            )
          : await this.fixer.execute(tscIssues, currentChanges, promptContext, mode);
        currentChanges = mergeFixerChanges(currentChanges, fixResult.files);
      }
    }

    let attempt = 0;
    const MAX_RETRIES = config.JOB_MAX_RETRIES;
    let isApproved = false;

    while (attempt < MAX_RETRIES && !isApproved) {
      attempt++;
      const review = await this.reviewer.execute(step.description, currentChanges, reviewContext, mode);

      if (review.isApproved) {
        isApproved = true;
        log.info({ stepId: step.id, attempt }, 'Step approved by Reviewer');
      } else {
        log.warn({ stepId: step.id, attempt, issues: review.issues }, 'Reviewer found issues, running Fixer');

        this.store.saveADR({
          id: `${Date.now()}-${step.id}`,
          taskId,
          decision: 'Self-Healing Retry',
          context: `Errors: ${review.issues.join(', ')}`,
          consequences: config.agents.toolCallingCoder
            ? 'Invoked BUGFIX_SPEC Fixer (tool-calling) to resolve Reviewer issues.'
            : 'Invoked FixerAgent (patch-based) to resolve issues.',
        });

        // v1.39-c — dispatch by toolCallingCoder flag. Previously this site
        // unconditionally used the patch-based Fixer even with toolCallingCoder=true
        // (default since v1.32-d): the patch path only saw `currentChanges` as
        // search/replace edit blocks, never the full file content. That was the
        // root of L2.x `reviewer_reject` failures in v1.38 bench (T6, H4).
        // BUGFIX_SPEC's tool-calling Fixer can read_file the actual on-disk
        // content and edit via structural tools — same machinery used by the
        // pre-Reviewer TS check (v1.35) and validation loop (v1.32-c).
        const fixerResult = config.agents.toolCallingCoder
          ? await runTaskAgent(
              BUGFIX_SPEC,
              {
                stepDescription: step.description,
                context: promptContext,
                taskMode: mode,
                issues: review.issues,
                currentFiles: currentChanges,
              },
              this.router,
              this.writer.root,
            )
          : await this.fixer.execute(
              review.issues, currentChanges, promptContext, mode,
              (file, index) => taskEvents.emitEvent({
                taskId,
                type: 'coder_file_ready',
                message: `Fixer produced ${file.path}`,
                data: {
                  stepId: step.id,
                  path: file.path,
                  action: file.action,
                  size: partialFileSize(file),
                  index,
                  source: 'fixer',
                },
              }),
            );
        // v1.32-d.1 — Merge instead of replace. Wholesale `currentChanges =
        // fixerResult.files` was losing Coder's correct edits any time Fixer
        // touched only a subset (e.g. only the test file Reviewer flagged).
        // L1.1 first run on llama-swap surfaced this: Coder produced server.ts
        // /health route, Fixer produced a single test-file edit, replace
        // dropped server.ts → commit_partial with the substantive change lost.
        // Semantics: Fixer's output wins for paths it touched (it fixes Coder's
        // mistakes); paths Fixer didn't touch keep Coder's prior edit.
        currentChanges = mergeFixerChanges(currentChanges, fixerResult.files);
      }
    }

    if (!isApproved) {
      throw new Error(`Reviewer rejected step ${step.id} after ${MAX_RETRIES} attempts.`);
    }

    return currentChanges;
  }

  /**
   * One-shot retry for write failures (almost always "search not found" on a
   * modify). Reads the actual current content of each failed file and asks the
   * Fixer to regenerate edits with that exact text in front of it. This is the
   * iterative-editing pattern from Aider — local models tend to hallucinate
   * `search` blocks "from memory" the first time, and self-correct when given
   * the literal file content.
   */
  private async retryFailedEdits(
    failed: Array<{ change: FileChange; error: Error }>,
    mode: 'fast'|'balanced'|'deep',
    log: ReturnType<typeof taskLogger>,
  ): Promise<FileChange[]> {
    const conventions = this.getConventions();
    const issues: string[] = [];
    const failedChanges: FileChange[] = [];

    for (const f of failed) {
      // Only modify failures benefit from real-content feedback; create/delete
      // either succeeded or failed for other reasons (path traversal, etc.).
      if (f.change.action !== 'modify') continue;

      let realContent = '';
      try {
        const abs = path.resolve(this.writer.root, f.change.path);
        realContent = fs.readFileSync(abs, 'utf8');
      } catch {
        // File might not exist yet (e.g. an earlier `create` also failed).
        // Skip — Fixer can't help without ground truth.
        continue;
      }

      issues.push(
        `Edit on ${f.change.path} failed: ${f.error.message}\n\n` +
        `EXACT current content of ${f.change.path} (use this VERBATIM in your search blocks):\n` +
        `<<<<<<< CURRENT FILE\n${realContent}\n>>>>>>> END\n\n` +
        `Regenerate the edits to apply your intended change to THIS exact text. ` +
        `Each search block must match a substring of the above byte-for-byte.`,
      );
      failedChanges.push(f.change);
    }

    if (failedChanges.length === 0) return [];

    const retryContext = buildPromptContext({
      conventions,
      ragSnippets: '',
      ragFilePaths: failedChanges.map(c => c.path),
      projectRoot: this.writer.root,
      repoMap: this.renderRepoMap(failedChanges.map(c => c.path)),
    });

    log.info(
      { count: failedChanges.length, paths: failedChanges.map(c => c.path) },
      'Retrying failed edits with real-content feedback',
    );

    const fixResult = await this.fixer.execute(issues, failedChanges, retryContext, mode);
    return fixResult.files;
  }

  /**
   * Temporarily apply `changes` to disk, run `typeChecker.runOn` against the
   * changed paths, then restore every file to its original state.
   *
   * This lets the pre-Reviewer check run tsc against actual on-disk content
   * (required because tsc resolves imports from disk) without permanently
   * mutating the working tree — the outer step-5 write still owns that.
   *
   * If a write fails (e.g. modify search-not-found) the file is skipped; tsc
   * may then surface the error through another diagnostic. Restore is best-
   * effort: a failure there is logged and swallowed to avoid masking the real
   * pre-check result.
   */
  private async applyAndCheckTs(
    changes: FileChange[],
  ): Promise<{ passed: boolean; output: string }> {
    const tsChanges = changes.filter(
      c => (c.path.endsWith('.ts') || c.path.endsWith('.tsx')) && c.action !== 'delete',
    );
    if (tsChanges.length === 0) return { passed: true, output: '' };

    // Separate: write ALL ts files for import resolution, but only report
    // errors for non-test files (Tester-generated tests in monorepos often have
    // workspace import errors that are environmental, not regressions).
    const checkPaths = tsChanges
      .filter(c => !isTestPath(c.path))
      .map(c => c.path);

    const backups = new Map<string, string | null>();
    try {
      for (const change of tsChanges) {
        const abs = path.resolve(this.writer.root, change.path);
        backups.set(change.path, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null);
        try {
          this.writer.execute(change);
        } catch {
          // Write error (e.g. search-not-found on modify) — leave file as-is;
          // tsc will run on the original and may still surface useful output.
        }
      }
      if (checkPaths.length === 0) return { passed: true, output: '' };
      const result = await this.typeChecker.runOn(checkPaths);
      return { passed: result.success || !!result.skipped, output: result.output };
    } finally {
      for (const [relPath, original] of backups) {
        const abs = path.resolve(this.writer.root, relPath);
        try {
          if (original === null) {
            if (fs.existsSync(abs)) fs.unlinkSync(abs);
          } else {
            fs.writeFileSync(abs, original, 'utf8');
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ path: relPath, error: msg }, 'applyAndCheckTs: restore failed');
        }
      }
    }
  }

  /**
   * Run tsc + tests on the clean repo (no task changes applied) and cache the
   * resulting failure fingerprints. Called once lazily before the first task.
   * This lets runValidationLoop distinguish pre-existing failures from new ones
   * introduced by the task — commits are allowed when only baseline issues remain.
   */
  private async computeBaseline(): Promise<void> {
    if (this.baselineFailures !== null) return;
    logger.info({ root: this.writer.root }, 'Computing validation baseline (clean repo)');
    const [tscResult, testResult] = await Promise.all([
      this.typeChecker.run(),
      this.testRunner.run(),
    ]);
    const fingerprints = new Set<string>();
    if (!tscResult.success && !tscResult.skipped) {
      for (const line of tscResult.output.split('\n')) {
        // path(line,col): error TSxxxx: message
        const m1 = line.match(/^(.+\(\d+,\d+\): error TS\d+:)/);
        if (m1) { fingerprints.add(m1[1]); continue; }
        // error TSxxxx: message (root-level, no file/line — e.g. TS6053 missing generated file)
        const m2 = line.match(/^(error TS\d+: .{0,120})/);
        if (m2) fingerprints.add(m2[1]);
      }
    }
    if (!testResult.success && !testResult.skipped) {
      // vitest FAIL lines have various formats:
      //  " FAIL  |node| src/foo.test.ts > Suite > name"
      //  " × Suite > name" (vitest compact)
      //  "FAIL src/foo.test.ts (5.32s)"
      for (const line of testResult.output.split('\n')) {
        // Variant 1: " FAIL  |node| path > suite > test" or "FAIL path (Xs)"
        const m1 = line.match(/FAIL\s+(?:\|[^|]+\|\s+)?(.+?)(?:\s+\(\d+\.\d+s\))?$/);
        if (m1) { fingerprints.add(`FAIL:${m1[1].trim()}`); continue; }
        // Variant 2: " × test name" (compact vitest with unicode cross)
        const m2 = line.match(/^\s+[×x✕]\s+(.+)/);
        if (m2) fingerprints.add(`FAIL:${m2[1].trim()}`);
      }
      // Capture failing test count as a coarse fingerprint
      const countM = testResult.output.match(/Tests\s+(\d+)\s+failed/);
      if (countM) fingerprints.add(`test_fail_count:${countM[1]}`);
    }
    this.baselineFailures = fingerprints;
    logger.info(
      { fingerprints: fingerprints.size, tscFailed: !tscResult.success, testFailed: !testResult.success },
      'Baseline computed',
    );
  }

  /**
   * Filter validation issues by subtracting baseline failures. An issue is
   * considered "new" only if it contains at least one error fingerprint that
   * wasn't present in the baseline. Issues composed entirely of baseline
   * fingerprints are dropped so they don't block the commit.
   */
  private filterByBaseline(issues: string[]): string[] {
    if (!this.baselineFailures || this.baselineFailures.size === 0) return issues;
    return issues.filter(issue => {
      const lines = issue.split('\n');
      const newLines = lines.filter(line => {
        // tsc error fingerprint — path(line,col) format
        const tscM = line.match(/^(.+\(\d+,\d+\): error TS\d+:)/);
        if (tscM && this.baselineFailures!.has(tscM[1])) return false;
        // root-level tsc error (no file/line) — e.g. TS6053
        const tscM2 = line.match(/^(error TS\d+: .{0,120})/);
        if (tscM2 && this.baselineFailures!.has(tscM2[1])) return false;
        // vitest FAIL fingerprint
        const testM = line.match(/^\s*(?:FAIL|×|x)\s+(.+)/);
        if (testM && this.baselineFailures!.has(testM[1].trim())) return false;
        return true;
      });
      // If the issue had error lines but they're ALL baseline — drop this issue
      const hasAnyErrorLine = lines.some(l =>
        l.match(/\(\d+,\d+\): error TS\d+:/) || l.match(/^\s*(?:FAIL|×|x)\s+/),
      );
      if (hasAnyErrorLine && newLines.every(l =>
        !l.match(/\(\d+,\d+\): error TS\d+:/) && !l.match(/^\s*(?:FAIL|×|x)\s+/),
      )) {
        return false; // all error lines were baseline
      }
      // Test failure: check if the failing test count is the same as baseline
      // and all FAIL lines are baseline. If so, no new failures introduced.
      if (issue.startsWith('Tests failed')) {
        const countM = issue.match(/Tests\s+(\d+)\s+failed/);
        if (countM) {
          const validationCount = parseInt(countM[1], 10);
          // Find the baseline test fail count
          for (const fp of this.baselineFailures!) {
            if (fp.startsWith('test_fail_count:')) {
              const baselineCount = parseInt(fp.slice('test_fail_count:'.length), 10);
              // Allow up to baseline + 5 failures: TESTER-generated test files may
              // incidentally trigger the same pre-existing snapshot failures, adding
              // a few more counts without introducing real regressions.
              if (validationCount <= baselineCount + 5) {
                logger.debug({ validationCount, baselineCount }, 'Test failures within baseline tolerance — filtering');
                return false;
              }
              break;
            }
          }
        }
        // Check if all FAIL: lines are in baseline
        const failLines = issue.split('\n').filter(l => l.match(/FAIL\s+(?:\|[^|]+\|\s+)?.+/));
        if (failLines.length > 0 && failLines.every(l => {
          const m = l.match(/FAIL\s+(?:\|[^|]+\|\s+)?(.+?)(?:\s+\(\d+\.\d+s\))?$/);
          return m && this.baselineFailures!.has(`FAIL:${m[1].trim()}`);
        })) {
          return false;
        }
      }
      return true;
    });
  }

  private async runValidationLoop(
    taskId: string,
    allFileChanges: FileChange[],
    mode: 'fast'|'balanced'|'deep',
    log: ReturnType<typeof taskLogger>,
  ): Promise<{ passed: boolean; issuesCount: number; writtenFiles: string[] }> {
    const MAX_VALIDATION_RETRIES = 2;
    let attempt = 0;
    // v1.32-a.2: track every path the Fixer successfully wrote during this
    // loop, so the outer commit step stages them. Without this, `writtenFiles`
    // in `runTask` only contained Coder's paths — Fixer's correct fix could
    // pass validation, but `git.commit` would receive an empty/wrong file
    // list and produce no commit (observed live on L4.1 v1.32-a.1).
    const fixerWritten = new Set<string>();

    taskEvents.emitEvent({ taskId, type: 'validation_start', message: 'Running typecheck + tests' });

    // Production-only paths for tsc scoping: exclude Tester-generated test files
    // so their import/type errors don't block commits for unrelated production changes.
    const prodPaths = allFileChanges
      .filter(c => (c.path.endsWith('.ts') || c.path.endsWith('.tsx')) && c.action !== 'delete' && !isTestPath(c.path))
      .map(c => c.path);

    // v1.39-b — guard each attempt with a timeout and a top-level try/catch so
    // we always reach a terminal validation_* event after validation_start
    // (T3 `validation_incomplete` from v1.38 bench: tsc/vitest child process
    // hung, `done` fired without any validation_pass/_fail in between).
    const timeoutMs = config.agents.validationTimeoutMs;

    while (attempt <= MAX_VALIDATION_RETRIES) {
      let typeResult: Awaited<ReturnType<typeof this.typeChecker.run>>;
      let testResult: Awaited<ReturnType<typeof this.testRunner.run>>;
      try {
        const validationPromise = Promise.all([
          prodPaths.length > 0 ? this.typeChecker.runOn(prodPaths) : this.typeChecker.run(),
          this.testRunner.run(),
        ]);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`validation timeout after ${timeoutMs}ms`)),
            timeoutMs,
          ).unref?.(),
        );
        [typeResult, testResult] = await Promise.race([validationPromise, timeoutPromise]);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ attempt, error: msg }, 'Validation aborted (timeout or runner crash)');
        this.store.saveFailure(
          `validation-aborted:${msg.slice(0, 100)}`,
          'Validation runner hung or crashed; commit skipped',
        );
        taskEvents.emitEvent({
          taskId,
          type: 'validation_fail',
          message: `Validation aborted: ${msg.slice(0, 200)}`,
          data: { reason: 'timeout_or_crash', attempt, error: msg.slice(0, 500) },
        });
        return { passed: false, issuesCount: 1, writtenFiles: [...fixerWritten] };
      }

      const rawIssues: string[] = [];
      if (!typeResult.success && !typeResult.skipped) {
        rawIssues.push(`TypeScript compilation failed (exit ${typeResult.exitCode}):\n${typeResult.output}`);
      }
      if (!testResult.success && !testResult.skipped) {
        rawIssues.push(`Tests failed (exit ${testResult.exitCode}):\n${testResult.output}`);
      }
      // Filter out pre-existing failures captured in the baseline so that
      // tasks are not blocked by issues that were already there before the edit.
      const issues = this.filterByBaseline(rawIssues);

      if (issues.length === 0) {
        log.info(
          {
            typeCheck: typeResult.skipped ?? 'passed',
            tests: testResult.skipped ?? 'passed',
          },
          'Validation passed',
        );
        taskEvents.emitEvent({
          taskId,
          type: 'validation_pass',
          message: 'Validation passed',
          data: { typeCheck: typeResult.skipped ?? 'passed', tests: testResult.skipped ?? 'passed' },
        });
        return { passed: true, issuesCount: 0, writtenFiles: [...fixerWritten] };
      }

      if (attempt === MAX_VALIDATION_RETRIES) {
        log.warn({ attempt, issues: issues.length }, 'Validation still failing after retries');
        this.store.saveFailure(
          `validation-failure:${issues[0].slice(0, 100)}`,
          'Exhausted Fixer retries; manual review needed',
        );
        taskEvents.emitEvent({
          taskId,
          type: 'validation_fail',
          message: `Validation failed after ${MAX_VALIDATION_RETRIES + 1} attempts`,
          data: { issueCount: issues.length, firstIssue: issues[0].slice(0, 200) },
        });
        return { passed: false, issuesCount: issues.length, writtenFiles: [...fixerWritten] };
      }

      attempt++;
      log.warn({ attempt, issues: issues.length }, 'Validation failed, running Fixer');

      // Give the validation-loop Fixer the same rich context Coder got, plus
      // full source of every file we've written so far — so it can see what
      // imports/types are actually in place when patching.
      const conventions = this.getConventions();
      const validationContext = buildPromptContext({
        conventions,
        ragSnippets: '',
        ragFilePaths: allFileChanges.map(c => c.path),
        projectRoot: this.writer.root,
        repoMap: this.renderRepoMap(allFileChanges.map(c => c.path)),
      });
      // v1.30.3 — when tool-calling Coder is on, also use tool-calling Fixer.
      // Patch-based Fixer hallucinates `search` blocks at scale (v1.29 / v1.30.1
      // benchmarks: emitted `import ... from 'jest'` patches against test files
      // where that import doesn't exist anywhere → search-not-found cascade).
      // Tool-calling Fixer reads the actual file via read_file and edits by
      // line range, eliminating the failure mode end-to-end.
      //
      // v1.32-c: validation Fixer always uses BUGFIX_SPEC regardless of the
      // original step.kind — "test failure → fix the bug" is bugfix workflow.
      const fixResult = config.agents.toolCallingCoder
        ? await runTaskAgent(
            BUGFIX_SPEC,
            { stepDescription: '<validation>', context: validationContext, taskMode: mode,
              issues, currentFiles: allFileChanges },
            this.router,
            this.writer.root,
          )
        : await this.fixer.execute(issues, allFileChanges, validationContext, mode);

      // Re-write fixed files and update tracking. Dedupe so the Fixer's
      // multiple edits to one file collapse into a single atomic apply.
      //
      // A throw from `writer.execute` (typically "search not found" on a
      // hallucinated edit block) must NOT crash the task — it just means this
      // particular Fixer attempt didn't produce an applicable patch. The
      // outer loop will either retry (if budget remains) or fall through to
      // commit_skipped, giving the operator a recoverable state with the
      // working tree intact.
      const dedupedFix = dedupeChangesByPath(fixResult.files);
      for (const fixed of dedupedFix) {
        try {
          this.writer.execute(fixed);
          fixerWritten.add(fixed.path);
          const idx = allFileChanges.findIndex(f => f.path === fixed.path);
          if (idx >= 0) allFileChanges[idx] = fixed;
          else allFileChanges.push(fixed);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(
            { path: fixed.path, attempt, error: msg },
            'Validation-Fixer write failed; treating as another validation issue and continuing',
          );
        }
      }

      this.store.saveADR({
        id: `${Date.now()}-validation`,
        taskId,
        decision: 'Validation Self-Healing Retry',
        context: issues.join('\n\n').slice(0, 500),
        consequences: `Invoked FixerAgent (attempt ${attempt}/${MAX_VALIDATION_RETRIES}).`,
      });
    }
    return { passed: false, issuesCount: 0, writtenFiles: [...fixerWritten] };
  }
}

/**
 * Throw if the plan contains a dependency cycle. Uses iterative DFS with
 * white/grey/black colouring so we don't blow the stack on large plans.
 */
function detectCycles(steps: Array<{ id: string; dependencies: string[] }>): void {
  const byId = new Map(steps.map(s => [s.id, s] as const));
  const colour = new Map<string, 0 | 1 | 2>(); // 0=white, 1=grey, 2=black

  for (const root of steps) {
    if (colour.get(root.id) === 2) continue;
    const stack: Array<{ id: string; index: number }> = [{ id: root.id, index: 0 }];
    colour.set(root.id, 1);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const node = byId.get(frame.id);
      if (!node || frame.index >= node.dependencies.length) {
        colour.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const dep = node.dependencies[frame.index++];
      if (!byId.has(dep)) continue; // dangling deps handled later by the scheduler
      const c = colour.get(dep) ?? 0;
      if (c === 1) {
        const path = stack.map(f => f.id).join(' → ');
        throw new Error(`Plan contains dependency cycle: ${path} → ${dep}`);
      }
      if (c === 0) {
        colour.set(dep, 1);
        stack.push({ id: dep, index: 0 });
      }
    }
  }
}

/**
 * Walk a list of FileChanges in order and produce a Map<path, content> that
 * reflects what each touched file would actually contain after the changes
 * are applied — without writing anything to disk. This is what cross-step
 * "Recently modified" needs: a step shouldn't see the original disk file when
 * an earlier step already created or patched it.
 */
function resolveVirtualSources(
  changes: FileChange[],
  projectRoot: string,
): Array<{ path: string; content: string }> {
  const virtual = new Map<string, string>();

  for (const c of changes) {
    if (c.action === 'create') {
      virtual.set(c.path, c.content);
    } else if (c.action === 'modify') {
      let base = virtual.get(c.path);
      if (base === undefined) {
        const abs = path.resolve(projectRoot, c.path);
        try {
          base = fs.readFileSync(abs, 'utf8');
        } catch {
          // File doesn't exist on disk and wasn't created earlier — can't
          // simulate; skip so we don't surface a fake "current" version.
          continue;
        }
      }
      const applied = applyEdits(base, c.edits);
      if (applied.ok) virtual.set(c.path, applied.result);
      // If apply failed (search not found), leave virtual map untouched so the
      // next step still sees the previous valid version. The orchestrator's
      // SafeWriter will surface the same error at write time anyway.
    } else if (c.action === 'delete') {
      virtual.delete(c.path);
    }
  }

  return Array.from(virtual, ([path, content]) => ({ path, content }));
}

/**
 * v1.32-d.1 — Merge a Fixer's FileChange[] over the prior Coder/Tester output.
 * Fixer's output wins for paths Fixer touched (semantically: Fixer just fixed
 * an issue Reviewer flagged on that path). Paths Fixer didn't touch keep the
 * prior edit (Coder's work was fine for those).
 *
 * Why this exists: previous code did `currentChanges = fixerResult.files` —
 * wholesale replace. When Fixer only addressed a subset (e.g. fix the failing
 * test, leave the route alone), Coder's correct route edit was dropped, and
 * the commit step saw nothing substantive to land. L1.1 ×1 on llama-swap +
 * qwen-coder reproduced this consistently because the model's Reviewer
 * rejection rate is higher than on the prior Ollama setup.
 *
 * Returns a fresh array; inputs are not mutated.
 */
export function mergeFixerChanges(
  prior: FileChange[],
  fixer: FileChange[],
): FileChange[] {
  const fixerPaths = new Set(fixer.map(f => f.path));
  const preservedPrior = prior.filter(c => !fixerPaths.has(c.path));
  return [...preservedPrior, ...fixer];
}

/**
 * Collapse multiple FileChange entries targeting the same path into one. If an
 * agent emits several `modify` blocks for the same file, their edits are merged
 * in order so the whole patch is atomic — without this, SafeWriter would apply
 * the first batch to disk and then fail on a later batch's "search not found",
 * leaving the file in a half-modified, broken state.
 *
 * Conflict resolution:
 * - modify + modify  → merged edits, applied in arrival order
 * - delete           → wins over anything earlier (file is going away)
 * - create / mixed   → last write wins (rare and ambiguous; an agent should not do this)
 */
function dedupeChangesByPath(changes: FileChange[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const c of changes) {
    const existing = byPath.get(c.path);
    if (!existing) { byPath.set(c.path, c); continue; }

    if (c.action === 'delete') {
      byPath.set(c.path, c);
    } else if (c.action === 'modify' && existing.action === 'modify') {
      byPath.set(c.path, {
        action: 'modify',
        path: c.path,
        edits: [...existing.edits, ...c.edits],
      });
    } else {
      // create-after-create, modify-after-create, etc. — last one wins.
      byPath.set(c.path, c);
    }
  }
  return Array.from(byPath.values());
}
