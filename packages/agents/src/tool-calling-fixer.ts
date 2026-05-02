import { ModelRouter } from '@rag-system/model-router';
import type { ToolLoopMessage } from '@rag-system/model-router';
import type { ModelRole, TaskMode, FileChange } from '@rag-system/shared';
import { extractAllowedPaths } from './tool-calling-coder.js';
import type { FixerOutput } from './fixer.js';

/**
 * Fixer reimagined as a tool-calling loop, sibling to ToolCallingCoderAgent.
 *
 * Why this exists: v1.30.1 benchmark on rag-system surfaced that the
 * patch-based Fixer (used in `runValidationLoop`) suffers the SAME failure
 * mode at scale that the patch-based Coder did — search-block hallucination.
 * Fixer was emitting `{search: "import ... from 'jest'", replace: "..."}`
 * for test files where that import doesn't exist anywhere; every search
 * missed; nothing landed; commit_skipped. Migrating Fixer to tool-calling
 * uses the same coordinate-based primitives as Coder and inherits the same
 * scope discipline.
 *
 * Differences from Coder:
 * - Input is a list of validation issues (typecheck/test failures), not a
 *   step description.
 * - Allowed write set is derived from BOTH the issues' file references AND
 *   the files the Coder already produced — a Fixer should be able to edit
 *   anything Coder touched, plus anything an error message points at.
 * - System prompt is fix-shaped: minimal targeted edits, restore imports
 *   instead of deleting the code that uses them, address only the listed
 *   issues.
 */

// Conversation pruning thresholds. v1.30.3 live benchmark showed Ollama
// `fetch failed` after ~7 minutes of Fixer round-trips on a 91-file project —
// the conversation grew linearly (each round adds 2 messages) until the llama
// runner OOMed. Keep system prompt + the initial user task message intact,
// trim the middle of the round-trip log, keep the most recent K rounds.
//
// Numbers picked empirically: on 25 max calls, K=8 means we always show the
// last 8 round-trips even when the loop has run further. System+user adds 2;
// total kept = 2 + 16 = 18 messages, well under any model's context limit.
const HISTORY_PRUNE_THRESHOLD = 22; // start pruning once total messages exceed this
const HISTORY_KEEP_TAIL = 16;       // keep this many trailing messages (8 round-trips)
const HISTORY_KEEP_HEAD = 2;        // keep system prompt + initial user message

export function pruneHistory(messages: ToolLoopMessage[]): boolean {
  if (messages.length <= HISTORY_PRUNE_THRESHOLD) return false;
  const head = messages.slice(0, HISTORY_KEEP_HEAD);
  const tail = messages.slice(-HISTORY_KEEP_TAIL);
  // Add a synthetic note about the truncation so the model knows it happened.
  const note: ToolLoopMessage = {
    role: 'user',
    content:
      `[Conversation pruned: ${messages.length - HISTORY_KEEP_HEAD - HISTORY_KEEP_TAIL} earlier tool-call rounds omitted to fit context. Continue from the most recent state.]`,
  };
  messages.length = 0;
  messages.push(...head, note, ...tail);
  return true;
}

/**
 * v1.32-c: FIXER_SYSTEM_PROMPT and the local copy of ALWAYS_FORBIDDEN_PATTERNS
 * have moved to task-agents/bugfix.ts (BUGFIX_SPEC.systemPrompt) and
 * tool-calling-coder.ts (canonical ALWAYS_FORBIDDEN_PATTERNS). This file
 * retains the helpers (`pruneHistory`, `buildFixerAllowedSet`, `isTestPath`,
 * `FIXER_TEST_PATH_FORBIDDEN`) consumed by BUGFIX_SPEC and the runner, plus
 * a thin class wrapper preserving the public API.
 */

/**
 * Test-file paths the Fixer is not trusted to write to unless the Coder
 * already touched the same file. Surfaced by v1.31.2's L4.1 bench, where
 * Fixer "fixed" a TestRunner failure by mutating the test (`user.createdAt
 * = new Date()`) instead of fixing the production bug it asserted against.
 * The cheapest path to a green assertion is to silence the assertion —
 * which is precisely what we don't want.
 *
 * The patterns match how vitest/jest projects organize tests:
 *   - `tests/foo.test.ts` (top-level tests/ dir)
 *   - `packages/x/src/__tests__/foo.test.ts` (co-located __tests__)
 *   - `src/foo.test.ts` (file-suffix convention)
 *
 * v1.32-a uses these for `buildFixerAllowedSet` filtering. v1.32-a.1
 * additionally adds them to the Fixer policy's `forbiddenPatterns` so
 * read-grants-write cannot bypass the test-scope discipline (read a test
 * → edit the assertion to silence it). Coder-produced tests remain
 * writable because explicit `policy.allowed.has(path)` wins over forbidden.
 */
const TEST_PATH_PATTERNS: RegExp[] = [
  /(?:^|\/)tests\//,
  /(?:^|\/)__tests__\//,
  /\.test\.(?:ts|tsx|js|jsx|mjs|cjs)$/,
  /\.spec\.(?:ts|tsx|js|jsx|mjs|cjs)$/,
];

/**
 * Alias of TEST_PATH_PATTERNS used in the Fixer policy's `forbiddenPatterns`.
 * Lives separate from TEST_PATH_PATTERNS purely for code readability — the
 * declaration site for the filter (`isTestPath` below) reads naturally as
 * "what counts as a test path"; the forbidden-list usage reads naturally as
 * "the Fixer forbidden additions." Same regex set, different consumers.
 */
export const FIXER_TEST_PATH_FORBIDDEN: RegExp[] = TEST_PATH_PATTERNS;

export function isTestPath(p: string): boolean {
  return TEST_PATH_PATTERNS.some(re => re.test(p));
}

/**
 * Build the Fixer's allowed-write set: union of paths Coder produced AND
 * paths mentioned in any issue (typecheck errors quote `file.ts:42:`,
 * test failures quote test paths). Either source can legitimately need an
 * edit to fix the validation problem.
 *
 * v1.32-a discipline: test-file paths are dropped from the issue-mention
 * pool unless the Coder also touched them. Rationale (L4.1): when a
 * TestRunner failure mentions `tests/foo.test.ts`, the model can write
 * either to the test (silence the assertion) or to the production code
 * the assertion exercises. Without this filter, the cheapest LLM action
 * is to mutate the test — which we observed live, with a green commit
 * shipping a still-broken bug. The Coder genuinely needing a test edit
 * always opens the test in its own loop first, so its files are still in
 * the allowed set.
 *
 * Tradeoff: a real "Coder changed an API and tests need to follow but
 * Coder didn't update them" scenario will now bail with commit_skipped
 * instead of being papered over. We treat that as the correct signal —
 * the Coder's work is incomplete, the operator needs to know.
 */
export function buildFixerAllowedSet(currentFiles: FileChange[], issues: string[]): Set<string> {
  const coderPaths = new Set<string>();
  for (const f of currentFiles) coderPaths.add(f.path);

  const out = new Set<string>(coderPaths);
  for (const issue of issues) {
    for (const p of extractAllowedPaths(issue)) {
      if (isTestPath(p) && !coderPaths.has(p)) continue;
      out.add(p);
    }
  }
  return out;
}

/**
 * v1.32-c thin wrapper preserving the historical class API. The actual loop
 * now lives in `task-agents/runner.ts`; this class delegates to
 * `runTaskAgent(BUGFIX_SPEC, ...)`. Kept so existing tests
 * (`new ToolCallingFixerAgent(router).execute(...)`) and any external call
 * sites continue to work without source changes.
 */
export class ToolCallingFixerAgent {
  name = 'Fixer(tool-calling)';
  role: ModelRole = 'fixer';
  private router: ModelRouter;

  constructor(router: ModelRouter) {
    this.router = router;
  }

  async execute(
    issues: string[],
    currentFiles: FileChange[],
    context: string,
    taskMode: TaskMode,
    projectRoot: string,
  ): Promise<FixerOutput> {
    const { BUGFIX_SPEC } = await import('./task-agents/bugfix.js');
    const { runTaskAgent } = await import('./task-agents/runner.js');
    return runTaskAgent(
      BUGFIX_SPEC,
      { stepDescription: '<validation>', context, taskMode, issues, currentFiles },
      this.router,
      projectRoot,
    );
  }
}
