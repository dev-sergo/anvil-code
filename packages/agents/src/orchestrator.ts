import { ModelRouter } from '@rag-system/model-router';
import { GraphRetriever } from '@rag-system/rag';
import { SafeWriter, TestRunner, TypeChecker } from '@rag-system/safe-exec';
import { MemoryStore } from '@rag-system/memory';
import { GitEngine } from '@rag-system/git-engine';
import { PlannerAgent } from './planner.js';
import { CoderAgent } from './coder.js';
import { ArchitectAgent } from './architect.js';
import { TesterAgent } from './tester.js';
import { ReviewerAgent } from './reviewer.js';
import { FixerAgent } from './fixer.js';
import { FileChange, config, taskEvents, taskLogger, withTaskContext } from '@rag-system/shared';

export class Orchestrator {
  private planner: PlannerAgent;
  private architect: ArchitectAgent;
  private coder: CoderAgent;
  private tester: TesterAgent;
  private reviewer: ReviewerAgent;
  private fixer: FixerAgent;
  private typeChecker: TypeChecker;
  private testRunner: TestRunner;

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
    this.typeChecker = new TypeChecker(config.projectRoot);
    this.testRunner = new TestRunner(config.projectRoot);
  }

  async runTask(taskId: string, description: string, mode: 'fast'|'balanced'|'deep' = 'balanced') {
    const log = taskLogger(taskId);
    log.info({ mode }, 'Orchestrator started task');

    // 1. Create Git Branch
    await this.git.createBranchForTask(taskId);

    // 2. Retrieve Context
    const context = await this.retriever.retrieveContext(description);

    // 3. Plan
    const plan = await withTaskContext({ taskId }, () =>
      this.planner.execute(description, context, mode),
    );
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

    // 5. Write all files to disk
    for (const change of allFileChanges) {
      this.writer.execute(change);
      writtenFiles.push(change.path);
    }

    // 6. Validation loop: typecheck + tests, with Fixer retries
    await withTaskContext({ taskId }, () =>
      this.runValidationLoop(taskId, allFileChanges, mode, log),
    );

    // 7. Commit
    if (writtenFiles.length > 0) {
      await this.git.commitChanges(taskId, `Complete task: ${description.substring(0, 50)}`, writtenFiles);
      taskEvents.emitEvent({
        taskId,
        type: 'commit',
        message: `Committed ${writtenFiles.length} file(s)`,
        data: { fileCount: writtenFiles.length },
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

    log.info({ completed: completedSteps.size, failed: failedSteps.size }, 'Task completed');
    taskEvents.emitEvent({
      taskId,
      type: 'done',
      message: result ?? 'Task completed successfully',
      data: { completed: completedSteps.size, failed: failedSteps.size },
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

      const work = (async () => {
        try {
          const stepChanges = await withTaskContext({ taskId, stepId: step.id }, () =>
            this.executeStep(taskId, step, mode, log),
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
  ): Promise<FileChange[]> {
    const stepContext = await this.retriever.retrieveContext(step.description);
    const design = await this.architect.execute(step.description, stepContext, mode);

    const promptContext = `Design Context:\n${design.design}\n\nCodebase Context:\n${stepContext}`;
    const codeChanges = await this.coder.execute(step.description, promptContext, mode);

    const testChanges = await this.tester.execute(codeChanges.files, stepContext, mode);

    let currentChanges: FileChange[] = [...codeChanges.files, ...testChanges.testFiles];

    let attempt = 0;
    const MAX_RETRIES = config.JOB_MAX_RETRIES;
    let isApproved = false;

    while (attempt < MAX_RETRIES && !isApproved) {
      attempt++;
      const review = await this.reviewer.execute(step.description, currentChanges, stepContext, mode);

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

        const fixerResult = await this.fixer.execute(review.issues, currentChanges, stepContext, mode);
        currentChanges = fixerResult.files;
      }
    }

    if (!isApproved) {
      throw new Error(`Reviewer rejected step ${step.id} after ${MAX_RETRIES} attempts.`);
    }

    return currentChanges;
  }

  private async runValidationLoop(
    taskId: string,
    allFileChanges: FileChange[],
    mode: 'fast'|'balanced'|'deep',
    log: ReturnType<typeof taskLogger>,
  ): Promise<void> {
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
        return;
      }

      if (attempt === MAX_VALIDATION_RETRIES) {
        log.warn({ attempt, issues: issues.length }, 'Validation still failing after retries — committing anyway');
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
        return;
      }

      attempt++;
      log.warn({ attempt, issues: issues.length }, 'Validation failed, running Fixer');

      const fixResult = await this.fixer.execute(issues, allFileChanges, '', mode);

      // Re-write fixed files and update tracking
      for (const fixed of fixResult.files) {
        this.writer.execute(fixed);
        const idx = allFileChanges.findIndex(f => f.path === fixed.path);
        if (idx >= 0) allFileChanges[idx] = fixed;
        else allFileChanges.push(fixed);
      }

      this.store.saveADR({
        id: `${Date.now()}-validation`,
        taskId,
        decision: 'Validation Self-Healing Retry',
        context: issues.join('\n\n').slice(0, 500),
        consequences: `Invoked FixerAgent (attempt ${attempt}/${MAX_VALIDATION_RETRIES}).`,
      });
    }
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
