import fs from 'fs';
import path from 'path';
import { ModelRouter } from '@rag-system/model-router';
import { GraphRetriever } from '@rag-system/rag';
import { SafeWriter, TestRunner, TypeChecker, applyEdits } from '@rag-system/safe-exec';
import { MemoryStore } from '@rag-system/memory';
import { GitEngine } from '@rag-system/git-engine';
import { buildRepoMap } from '@rag-system/code-graph';
import { PlannerAgent } from './planner.js';
import { CoderAgent } from './coder.js';
import { ToolCallingCoderAgent } from './tool-calling-coder.js';
import { ArchitectAgent } from './architect.js';
import { TesterAgent } from './tester.js';
import { ReviewerAgent } from './reviewer.js';
import { FixerAgent } from './fixer.js';
import { partialFileSize, type PartialFile } from './partial-json.js';
import {
  FileChange,
  config,
  taskEvents,
  taskLogger,
  withTaskContext,
  readProjectConventions,
  buildPromptContext,
  type ProjectConventions,
} from '@rag-system/shared';

export class Orchestrator {
  private planner: PlannerAgent;
  private architect: ArchitectAgent;
  private coder: CoderAgent;
  private toolCallingCoder: ToolCallingCoderAgent;
  private tester: TesterAgent;
  private reviewer: ReviewerAgent;
  private fixer: FixerAgent;
  private typeChecker: TypeChecker;
  private testRunner: TestRunner;
  private conventions: ProjectConventions | null = null;

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
    this.toolCallingCoder = new ToolCallingCoderAgent(router);
    this.tester = new TesterAgent(router);
    this.reviewer = new ReviewerAgent(router);
    this.fixer = new FixerAgent(router);
    // Validators run against the project root the writer is bound to so
    // multi-project setups check the right codebase.
    this.typeChecker = new TypeChecker(this.writer.root);
    this.testRunner = new TestRunner(this.writer.root);
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

    // 1. Create Git Branch
    await this.git.createBranchForTask(taskId);

    // 2. Retrieve context + load project conventions.
    // Planner only needs a high-level view; it doesn't write files, so we feed it
    // the lighter string context. Full source files enter the prompt at step level
    // where Coder/Fixer/Tester actually need to preserve imports/style.
    const conventions = this.getConventions();
    const items = await this.retriever.retrieveContextItems(description);
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
    const { allFileChanges, completedSteps, failedSteps } = await this.executePlanParallel(
      taskId,
      plan.steps,
      mode,
      log,
    );

    if (completedSteps.size === 0) {
      throw new Error(`All ${plan.steps.length} steps failed; aborting task ${taskId}.`);
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

    // 7. Commit — skip if validation failed and the strict flag is on.
    // Branch still exists for the operator to inspect; nothing is lost.
    const shouldSkipCommit = !validation.passed && config.git.commitOnlyIfValid;
    if (writtenFiles.length > 0 && !shouldSkipCommit) {
      await this.git.commitChanges(taskId, `Complete task: ${description.substring(0, 50)}`, writtenFiles);
      taskEvents.emitEvent({
        taskId,
        type: 'commit',
        message: `Committed ${writtenFiles.length} file(s)`,
        data: { fileCount: writtenFiles.length },
      });
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
      { completed: completedSteps.size, failed: failedSteps.size, unrecovered: unrecoveredWrites.length },
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
        unrecoveredWrites,
      },
    });
  }

  private async executePlanParallel(
    taskId: string,
    steps: Array<{ id: string; description: string; dependencies: string[] }>,
    mode: 'fast'|'balanced'|'deep',
    log: ReturnType<typeof taskLogger>,
  ): Promise<{ allFileChanges: FileChange[]; completedSteps: Set<string>; failedSteps: Set<string> }> {
    detectCycles(steps);

    const allFileChanges: FileChange[] = [];
    const completedSteps = new Set<string>();
    const failedSteps = new Set<string>();
    const remaining = new Map(steps.map(s => [s.id, s] as const));
    const inFlight = new Map<string, Promise<void>>();
    const parallelism = Math.max(1, config.agents.parallelism);

    // A dep counts as satisfied only when it has actually settled (completed or failed).
    // Dangling ids that no step in the plan defines stay unsatisfied, which deliberately
    // strands the dependent step so the "stuck" detection below skips it.
    const isReady = (s: { dependencies: string[] }): boolean =>
      s.dependencies.every(d => completedSteps.has(d) || failedSteps.has(d));

    const launch = (step: { id: string; description: string; dependencies: string[] }) => {
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

      // Wait for at least one to settle so the next iteration can launch newly-ready steps
      await Promise.race(inFlight.values());
    }

    return { allFileChanges, completedSteps, failedSteps };
  }

  private async executeStep(
    taskId: string,
    step: { id: string; description: string; dependencies: string[] },
    mode: 'fast'|'balanced'|'deep',
    log: ReturnType<typeof taskLogger>,
    previousChanges: FileChange[] = [],
  ): Promise<FileChange[]> {
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

    const design = await this.architect.execute(
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
    const codeChanges = config.agents.toolCallingCoder
      ? await this.toolCallingCoder.execute(step.description, promptContext, mode, this.writer.root, onCoderFile)
      : await this.coder.execute(step.description, promptContext, mode, onCoderFile);

    let currentChanges: FileChange[] = [...codeChanges.files];
    if (config.agents.testerEnabled) {
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
          consequences: 'Invoked FixerAgent to resolve issues.',
        });

        const fixerResult = await this.fixer.execute(
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
        currentChanges = fixerResult.files;
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

  private async runValidationLoop(
    taskId: string,
    allFileChanges: FileChange[],
    mode: 'fast'|'balanced'|'deep',
    log: ReturnType<typeof taskLogger>,
  ): Promise<{ passed: boolean; issuesCount: number }> {
    const MAX_VALIDATION_RETRIES = 2;
    let attempt = 0;

    taskEvents.emitEvent({ taskId, type: 'validation_start', message: 'Running typecheck + tests' });

    while (attempt <= MAX_VALIDATION_RETRIES) {
      const [typeResult, testResult] = await Promise.all([
        this.typeChecker.run(),
        this.testRunner.run(),
      ]);

      const issues: string[] = [];
      if (!typeResult.success && !typeResult.skipped) {
        issues.push(`TypeScript compilation failed (exit ${typeResult.exitCode}):\n${typeResult.output}`);
      }
      if (!testResult.success && !testResult.skipped) {
        issues.push(`Tests failed (exit ${testResult.exitCode}):\n${testResult.output}`);
      }

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
        return { passed: true, issuesCount: 0 };
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
        return { passed: false, issuesCount: issues.length };
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
      const fixResult = await this.fixer.execute(issues, allFileChanges, validationContext, mode);

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
    return { passed: false, issuesCount: 0 };
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
