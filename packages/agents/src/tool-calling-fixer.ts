import { ModelRouter } from '@rag-system/model-router';
import type { ToolLoopMessage } from '@rag-system/model-router';
import type { ModelRole, TaskMode, FileChange } from '@rag-system/shared';
import { logger, taskEvents, currentTaskContext } from '@rag-system/shared';
import { WorkingSet } from './working-set.js';
import {
  TOOL_DEFINITIONS,
  dispatchToolCall,
  extractAllowedPaths,
  type WritePolicy,
} from './tool-calling-coder.js';
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

// Fixer should converge faster than Coder — it's addressing a known issue, not
// implementing a feature. Tighter budget keeps the conversation short and
// prevents the model from wandering into more issues than it was asked to fix.
const MAX_TOOL_CALLS = 25;

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

const FIXER_SYSTEM_PROMPT = `You are a Code Fixer. You make MINIMAL edits to fix listed validation issues. Only tool calls produce changes — text replies do nothing.

TOOLS (use the structural tool whose contract matches the fix; fall back to replace_in_file only for non-source content or unusual code shapes):
- read_file(path) — inspect a file (always free; opens write-scope on it for this loop)
- add_import(file, source, names, default_name?, type_only?) — for "Cannot find name X". REQUIRES the names array; bare add_import(file, source) makes a useless side-effect import.
- replace_method(file, container, name, source) — rewrite a class method body
- replace_function(file, name, source) — rewrite a top-level function
- add_method / add_route / add_export — introduce a new symbol
- replace_in_file(path, start_line, end_line, new_text) — last-resort line edit
- create_file / delete_file / done()

WORKFLOW:
1. Pick an issue. It names a file (TS error: "src/foo.ts:42") or a test (test failure: "tests/users.test.ts > UserService > ..."). Open that file with read_file.
2. If a test failed, the bug is almost always in the PRODUCTION module the test exercises — not in the test. Look at the test's import statements, read the production file, fix it there.
3. Make the smallest edit that resolves the issue. ADDRESS ONLY LISTED ISSUES — don't refactor working code.
4. Repeat for each issue, then call done().

SCOPE: read_file on any non-forbidden path grants write access to that path for the rest of this loop. So the resolution path for "I want to edit X but it's not in my allowed list" is always: call read_file(X), then retry the edit. Forbidden paths (package.json, tsconfig, lockfiles, .env, vitest/jest config, .gitignore) are never writable. Test files (tests/, __tests__/, *.test.ts, *.spec.ts) are not writable unless the Coder produced them — find the production code instead.

COMMON TS PATTERNS:
- "Cannot find name 'X'" → add_import the missing symbol. Don't delete the code that uses it.
- "Type Y is not assignable to Z" → fix the offending expression, not the whole function.
- Date arithmetic "left-hand side must be number" → \`d1.getTime() - d2.getTime()\`
- "as jest.Mock" → \`as ReturnType<typeof vi.fn>\`; \`import { vi } from 'vitest'\`.

Output: tool calls only. The first thing you call should be read_file on the file the first issue points at.`;

const ALWAYS_FORBIDDEN_PATTERNS_LOCAL: RegExp[] = [
  /(?:^|\/)package\.json$/,
  /(?:^|\/)package-lock\.json$/,
  /(?:^|\/)pnpm-lock\.yaml$/,
  /(?:^|\/)yarn\.lock$/,
  /(?:^|\/)tsconfig.*\.json$/,
  /(?:^|\/)vitest\.config\.(?:ts|js|mjs|cjs)$/,
  /(?:^|\/)jest\.config\.(?:ts|js|mjs|cjs)$/,
  /(?:^|\/)\.env(?:\..+)?$/,
  /(?:^|\/)turbo\.json$/,
  /(?:^|\/)\.gitignore$/,
];

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
const FIXER_TEST_PATH_FORBIDDEN: RegExp[] = TEST_PATH_PATTERNS;

function isTestPath(p: string): boolean {
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
    const ws = new WorkingSet(projectRoot);

    const allowed = buildFixerAllowedSet(currentFiles, issues);
    const policy: WritePolicy = {
      allowed,
      // Combine config-file forbidden list with test-file forbidden patterns.
      // Test paths are forbidden so v1.32-a.1's read-grants-write rule cannot
      // be used to bypass the v1.32-a test-scope discipline (read a test then
      // edit its assertions to silence them — the L4.1 game-the-test pattern).
      // A Coder-produced test stays writable because `policy.allowed.has(path)`
      // takes precedence over the forbidden check.
      forbiddenPatterns: [...ALWAYS_FORBIDDEN_PATTERNS_LOCAL, ...FIXER_TEST_PATH_FORBIDDEN],
    };

    const initiallyAllowed =
      allowed.size > 0
        ? [...allowed].join(', ')
        : '(none derivable — read_file the file each issue points at, then edit it)';

    const issuesBlock = issues.map((iss, i) => `[issue ${i + 1}] ${iss}`).join('\n\n');
    const filesSummary = currentFiles
      .map(f => {
        if (f.action === 'create') return `- ${f.path} (created by Coder, on disk)`;
        if (f.action === 'modify') return `- ${f.path} (modified by Coder, on disk)`;
        return `- ${f.path} (deleted by Coder)`;
      })
      .join('\n');

    // The user message lays out: issues → existing Coder files → write-scope
    // (with the read_file expansion rule positioned NEXT to the initial allowed
    // list so the model reads them as related, not as a static constraint
    // followed by an abstract policy hidden in the system prompt) → context.
    const messages: ToolLoopMessage[] = [
      { role: 'system', content: FIXER_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `Validation issues to fix:\n${issuesBlock}\n\n` +
          `Files the Coder already produced (current state on disk):\n${filesSummary || '(none)'}\n\n` +
          `Initially-allowed write targets: ${initiallyAllowed}\n` +
          `Scope expansion: read_file on any non-forbidden path grants write access to it for this loop. ` +
          `So if your fix needs to edit a file outside the initial list (e.g. a service module behind a failing test), call read_file on it first — then your edit will be allowed.\n\n` +
          `Project context:\n${context}\n\n` +
          `Start by calling read_file on the file the first issue references. Make minimal edits. Call done() when every listed issue is fixed.`,
      },
    ];

    const ctx = currentTaskContext();
    let toolCallsExecuted = 0;
    let doneCalled = false;
    // v1.32-a.3 — track consecutive text-only responses. Up to 2 retries with
    // progressively stronger nudges before bailing. The previous one-shot retry
    // ("Or call done() if no source edits can fix") gave the model an explicit
    // permission to bail, which it took ~50% of the time on L4.1. The new
    // nudges remove that escape and tell the model exactly what to call next.
    let consecutiveNoToolCalls = 0;

    for (let round = 0; round < MAX_TOOL_CALLS && !doneCalled; round++) {
      const response = await this.router.routeWithTools(this.role, messages, TOOL_DEFINITIONS, taskMode);
      const calls = response.toolCalls ?? [];

      if (calls.length === 0) {
        consecutiveNoToolCalls++;
        if (consecutiveNoToolCalls >= 3) {
          // Two retries already issued without a single tool call — model is
          // genuinely stuck. Break out; outer pipeline will surface
          // commit_skipped with the issues unaddressed.
          logger.warn(
            { agent: this.name },
            'Tool-calling Fixer emitted text-only response 3 times in a row; bailing',
          );
          break;
        }
        const nudge = consecutiveNoToolCalls === 1
          ? `You responded with text but did not call any tool. Tools are how fixes happen. Pick the file the first issue references; call read_file on it; then edit. Do that now — no preamble.`
          : `Still no tool call. The validation will not fix itself. The first listed issue points at a file path. Call read_file on that exact path RIGHT NOW. If you genuinely believe no source edit can fix the issues, call done() — but only as a tool call, not as text.`;
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: nudge });
        continue;
      }
      consecutiveNoToolCalls = 0;

      messages.push({ role: 'assistant', content: response.content, tool_calls: calls });

      for (const call of calls) {
        const result = dispatchToolCall(call, ws, policy);
        toolCallsExecuted++;
        messages.push({ role: 'tool', content: result.text, tool_name: call.function.name });

        if (ctx) {
          taskEvents.emitEvent({
            taskId: ctx.taskId,
            type: 'agent_stream',
            data: {
              agent: this.name,
              role: this.role,
              chunk: `[${call.function.name}] ${result.text.slice(0, 80)}`,
              totalLen: toolCallsExecuted,
              ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
            },
          });
        }

        if (result.done) {
          doneCalled = true;
          break;
        }
      }

      // Prune conversation history before the next Ollama round-trip. Without
      // this, long Fixer sessions on real projects crash the llama runner —
      // see v1.30.3 benchmark notes.
      if (pruneHistory(messages)) {
        logger.debug({ agent: this.name, retainedMessages: messages.length }, 'Pruned Fixer conversation history');
      }
    }

    if (toolCallsExecuted >= MAX_TOOL_CALLS && !doneCalled) {
      logger.warn(
        { agent: this.name, toolCalls: toolCallsExecuted },
        'Tool-calling Fixer hit MAX_TOOL_CALLS limit without calling done()',
      );
    }

    const files: FileChange[] = ws.toFileChanges();
    if (files.length === 0) {
      logger.debug({ agent: this.name }, 'Tool-calling Fixer produced no file changes — issues may not be source-fixable');
    }

    return { files };
  }
}
