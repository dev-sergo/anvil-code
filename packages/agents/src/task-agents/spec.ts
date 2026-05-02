import type { ModelRole, TaskMode, FileChange } from '@rag-system/shared';
import type { PlanStep } from '../planner.js';

/**
 * Input passed to a task-agent run. Three flavors of work fit through this
 * shape:
 *  - planner-driven (FEATURE / REFACTOR / BUGFIX-(b)) — `stepDescription` set
 *  - validation-driven (BUGFIX-(a) — Reviewer/typecheck/test failures) —
 *    `issues` + `currentFiles` set, `stepDescription` is a synthetic label
 *
 * Each spec's `buildAllowedSet` and `buildUserMessage` decide which fields
 * they consume.
 */
export interface TaskAgentInput {
  stepDescription: string;
  context: string;
  taskMode: TaskMode;
  // BugFix validation mode (a):
  issues?: string[];
  currentFiles?: FileChange[];
}

export interface TaskAgentOutput {
  files: FileChange[];
}

/**
 * Configuration for a single task-agent specialization. The shared
 * `runTaskAgent` loop (runner.ts) consumes this to drive the tool-calling
 * model. v1.32-c: three specs (FEATURE_SPEC, BUGFIX_SPEC, REFACTOR_SPEC) over
 * one shared loop replaces the previous duplicated ToolCallingCoder /
 * ToolCallingFixer classes.
 */
export interface TaskAgentSpec {
  kind: PlanStep['kind'];

  agentName: string;
  agentRole: ModelRole;

  systemPrompt: string;
  maxToolCalls: number;
  pruneHistory: boolean;

  emitPerFileEvents: boolean;
  perFileEventLabel: string;
  perFileEventSource?: 'fixer';

  buildAllowedSet: (input: TaskAgentInput) => Set<string>;
  forbiddenPatterns: RegExp[];
  buildUserMessage: (input: TaskAgentInput, allowed: Set<string>) => string;

  pathologyNudge: (toolName: string, filePath: string, threshold: number) => string;
  noToolCallsNudge: (attempt: 1 | 2) => string;
}
