import type { FileChange } from '@rag-system/shared';
import {
  ALWAYS_FORBIDDEN_PATTERNS,
  extractAllowedPaths,
} from '../tool-calling-coder.js';
import {
  buildFixerAllowedSet,
  FIXER_TEST_PATH_FORBIDDEN,
  isTestPath,
} from '../tool-calling-fixer.js';
import type { TaskAgentSpec, TaskAgentInput } from './spec.js';
import { BUGFIX_NAVIGATION_HINT } from './shared-prompts.js';

/**
 * v1.32-c BUGFIX_SPEC — two invocation modes through one spec:
 *  (a) Validation-driven: orchestrator.runValidationLoop calls with
 *      `issues + currentFiles` populated; spec is used regardless of the
 *      original step.kind because "test failure → fix the bug" is always
 *      bugfix workflow.
 *  (b) Planner-driven: step.kind === 'bugfix' (description = symptom);
 *      `stepDescription` populated, no issues/currentFiles. Behaves like a
 *      Coder but with the Fixer prompt + test-path-forbidden scope.
 *
 * Replaces ToolCallingFixerAgent. Validation-mode behavior preserved
 * verbatim except for the appended NAVIGATION hint that closes the L4.1
 * test-to-production traversal gap.
 */

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

Output: tool calls only. The first thing you call should be read_file on the file the first issue points at.${BUGFIX_NAVIGATION_HINT}`;

function buildBugFixAllowedSet(input: TaskAgentInput): Set<string> {
  // Validation mode (a): issues + currentFiles populated → preserve current
  // Fixer behavior (paths Coder touched ∪ paths issues mention, with test-
  // path filter unless Coder already touched).
  if (input.issues && input.currentFiles) {
    return buildFixerAllowedSet(input.currentFiles, input.issues);
  }
  // Planner-driven mode (b): step.kind === 'bugfix'. Pull paths from the
  // description, but drop test paths the same way (a) does — bugfix as a
  // task semantics still wants production-edit discipline.
  const out = new Set<string>();
  for (const p of extractAllowedPaths(input.stepDescription)) {
    if (isTestPath(p)) continue;
    out.add(p);
  }
  return out;
}

function buildBugFixUserMessage(input: TaskAgentInput, allowed: Set<string>): string {
  const initiallyAllowed = allowed.size > 0
    ? [...allowed].join(', ')
    : '(none derivable — read_file the file each issue points at, then edit it)';

  // Validation mode (a):
  if (input.issues && input.currentFiles) {
    const issuesBlock = input.issues.map((iss, i) => `[issue ${i + 1}] ${iss}`).join('\n\n');
    const filesSummary = input.currentFiles
      .map((f: FileChange) => {
        if (f.action === 'create') return `- ${f.path} (created by Coder, on disk)`;
        if (f.action === 'modify') return `- ${f.path} (modified by Coder, on disk)`;
        return `- ${f.path} (deleted by Coder)`;
      })
      .join('\n');
    return (
      `Validation issues to fix:\n${issuesBlock}\n\n` +
      `Files the Coder already produced (current state on disk):\n${filesSummary || '(none)'}\n\n` +
      `Initially-allowed write targets: ${initiallyAllowed}\n` +
      `Scope expansion: read_file on any non-forbidden path grants write access to it for this loop. ` +
      `So if your fix needs to edit a file outside the initial list (e.g. a service module behind a failing test), call read_file on it first — then your edit will be allowed.\n\n` +
      `Project context:\n${input.context}\n\n` +
      `Start by calling read_file on the file the first issue references. Make minimal edits. Call done() when every listed issue is fixed.`
    );
  }

  // Planner-driven mode (b):
  return (
    `Bug-fix task: ${input.stepDescription}\n\n` +
    `Initially-allowed write targets: ${initiallyAllowed}\n` +
    `Scope expansion: read_file on any non-forbidden path grants write access to it for this loop. ` +
    `Use that to navigate from the symptom to the production module that contains the bug.\n\n` +
    `Project context:\n${input.context}\n\n` +
    `Start by reading entry points (server.ts, routes/, services/) referenced in the task or context, then trace to the production code. Call done() when the bug is fixed.`
  );
}

export const BUGFIX_SPEC: TaskAgentSpec = {
  kind: 'bugfix',
  agentName: 'Fixer(tool-calling)',
  agentRole: 'fixer',
  systemPrompt: FIXER_SYSTEM_PROMPT,
  maxToolCalls: 30,
  pruneHistory: true,
  emitPerFileEvents: false,
  perFileEventLabel: 'Fixer produced',
  perFileEventSource: 'fixer',
  buildAllowedSet: buildBugFixAllowedSet,
  forbiddenPatterns: [...ALWAYS_FORBIDDEN_PATTERNS, ...FIXER_TEST_PATH_FORBIDDEN],
  buildUserMessage: buildBugFixUserMessage,
  pathologyNudge: (toolName, filePath, threshold) =>
    `You have called ${toolName} on "${filePath}" ${threshold} times and gotten the same kind of error each time. The current approach is not working — change strategy. Try one of: (a) read_file the path again to see the current state (line numbers shift after every edit); (b) a different tool — structural ones (add_method / replace_method / add_import) often handle cases where replace_in_file struggles; (c) call done() if you cannot make further progress. Do not retry the same call shape again.`,
  noToolCallsNudge: attempt =>
    attempt === 1
      ? `You responded with text but did not call any tool. Tools are how fixes happen. Pick the file the first issue references; call read_file on it; then edit. Do that now — no preamble.`
      : `Still no tool call. The validation will not fix itself. The first listed issue points at a file path. Call read_file on that exact path RIGHT NOW. If you genuinely believe no source edit can fix the issues, call done() — but only as a tool call, not as text.`,
};
