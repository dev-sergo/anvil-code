import { ModelRouter } from '@rag-system/model-router';
import type { ToolCall, ToolDefinition, ToolLoopMessage } from '@rag-system/model-router';
import type { ModelRole, TaskMode, FileChange } from '@rag-system/shared';
import { logger, taskEvents, currentTaskContext } from '@rag-system/shared';
import { WorkingSet } from './working-set.js';
import type { CoderOutput, FileReadyCallback } from './coder.js';

/**
 * Coder reimagined as a tool-calling loop.
 *
 * Why this exists: v1.29 scale benchmark showed the JSON+search-block Coder
 * (v1.23) cannot reliably modify files in a 91-file project. The model
 * hallucinates "search" strings that don't byte-match the actual file, all
 * 5 LLM calls in the patch pipeline (Coder + retry-Fixer + 3 × validation
 * Fixer) fail the same way, nothing lands. Root cause: writing JSON requires
 * the model to byte-quote existing code, which it can't do reliably once the
 * prompt is large.
 *
 * This Coder doesn't write JSON. It calls tools that take coordinates:
 * `read_file(path)`, `replace_in_file(path, start_line, end_line, new_text)`,
 * `create_file(path, content)`, `delete_file(path)`, `done()`. The model
 * navigates and edits via these calls; the runtime backs them with a
 * WorkingSet (in-memory file state). At `done()`, the WorkingSet is converted
 * to FileChange[] for the existing write+validation pipeline.
 *
 * Safety: each replace_in_file only mutates a line range the model named, with
 * actual disk content as the base. Code outside the named range is preserved
 * by construction — there is no search/replace step that could go wrong.
 */

const MAX_TOOL_CALLS = 50;

/**
 * Files that are off-limits even when the task description mentions them only
 * vaguely. The model must explicitly name the path in the task to be allowed
 * to touch any of these — they're configuration files where a wrong edit
 * silently breaks the whole project (build, install, run).
 *
 * Why explicit allow rather than total ban: if the task is "Update package.json
 * to add dependency X", the model legitimately needs to write package.json.
 * The path will appear in `policy.allowed` (extracted from the task) and the
 * forbidden check will be bypassed.
 */
const ALWAYS_FORBIDDEN_PATTERNS: RegExp[] = [
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
 * Pull file paths out of a task description so the dispatcher can later
 * enforce that the model only writes to those paths. Picks up anything that
 * looks like a relative path with a recognized source-file extension.
 *
 * Conservative on purpose: a path appearing in the description is treated as
 * "the operator gave permission to touch this file." Anything else is denied.
 * If no paths are mentioned (e.g. "fix the bug where users see duplicates")
 * we fall back to permissive mode in `isWriteAllowed` — empty whitelist means
 * no whitelist enforcement, only the forbidden list applies.
 */
export function extractAllowedPaths(taskDescription: string): Set<string> {
  const out = new Set<string>();
  // Match any token that contains a `/` and ends in a source-file extension,
  // OR a bare filename with one of those extensions. Strip surrounding
  // backticks/quotes/parens/commas.
  // \b after the extension prevents `.js` from greedily matching the prefix
  // of `.json`, `.jsx`, etc. — alternation is left-to-right and we want the
  // full extension token, not the first alternative that fits.
  const re = /[`"'(]?([a-zA-Z0-9_\-./]+?\.(?:tsx|jsx|mjs|cjs|json|yaml|svelte|toml|scss|html|yml|vue|css|ts|js|py|rs|go|md)\b)[`"',)]?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(taskDescription)) !== null) {
    let p = match[1];
    // Drop leading "./" — model writes look like "src/foo.ts" not "./src/foo.ts"
    if (p.startsWith('./')) p = p.slice(2);
    out.add(p);
  }
  return out;
}

export interface WritePolicy {
  /** Paths the task description explicitly named. Empty set ⇒ no whitelist enforcement. */
  allowed: Set<string>;
  /** Hardcoded patterns blocked unless the path appears in `allowed`. */
  forbiddenPatterns: RegExp[];
}

export function isWriteAllowed(path: string, policy: WritePolicy): { ok: true } | { ok: false; reason: string } {
  // Forbidden files override everything except an explicit task-description mention.
  for (const re of policy.forbiddenPatterns) {
    if (re.test(path) && !policy.allowed.has(path)) {
      return {
        ok: false,
        reason: `path "${path}" is in the project's protected configuration set (package.json, tsconfig, lockfiles, etc.) and is not named in the task — refusing to modify`,
      };
    }
  }
  // Whitelist enforcement only when the task names at least one path.
  if (policy.allowed.size > 0 && !policy.allowed.has(path)) {
    return {
      ok: false,
      reason: `path "${path}" is not named in the task description — only [${[...policy.allowed].join(', ')}] are in scope. If you really need to touch this file, the operator must add it to the task.`,
    };
  }
  return { ok: true };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        "Read a file's contents from the project. Returns the file as text with line numbers prepended in the format 'NNNN | <line>'. Use this to inspect the exact bytes of a file before deciding what to change. Path is project-relative (e.g. 'src/server.ts').",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative file path' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description:
        "Replace lines [start_line .. end_line] (1-indexed, inclusive) of a file with new_text. new_text may be multi-line. To delete the line range, pass an empty string for new_text. The file must already exist (use create_file for new files). Lines outside the named range are preserved exactly.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative file path' },
          start_line: { type: 'integer', description: 'First line to replace (1-indexed, inclusive)' },
          end_line: { type: 'integer', description: 'Last line to replace (1-indexed, inclusive). Can equal start_line for single-line edits.' },
          new_text: { type: 'string', description: 'Replacement text. Multi-line OK (use literal \\n). Empty string deletes the lines.' },
        },
        required: ['path', 'start_line', 'end_line', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_file',
      description:
        'Create a new file with the given content. Errors if the file already exists; use replace_in_file for modifications. The path may name a directory that does not yet exist — it will be created.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative path to the new file' },
          content: { type: 'string', description: 'Full content of the new file' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file from the project. Errors if the file does not exist.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative path' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description:
        'Signal that all changes for the current step are complete. After this, the runtime hands the file changes to the validator. Call this exactly once when finished. Do not call done() if you have made no changes — instead, call replace_in_file/create_file at least once first.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

const SYSTEM_PROMPT = `You are an expert Software Engineer working through tools.
Given a step description and project context, you implement the change by calling tools.

YOU CANNOT WRITE THE CODE DIRECTLY IN A REPLY. The only way to make changes is via tool calls:
- read_file(path) — see the actual current bytes of a file
- replace_in_file(path, start_line, end_line, new_text) — modify an existing file by line range
- create_file(path, content) — make a new file
- delete_file(path) — remove a file
- done() — signal completion

Workflow:
1. If you're modifying an existing file, ALWAYS call read_file first to see its actual content with line numbers. This is non-negotiable — you must base every replace_in_file on the lines you just read.
2. Decide the smallest possible edit. Replace as few lines as practical.
3. Call replace_in_file (or create_file for new files). The "new_text" you provide is inserted verbatim — pay attention to indentation matching the surrounding code.
4. Read again if a follow-up edit depends on the new state.
5. When the step is complete, call done() exactly once.

CONTENT COMES FROM THE TASK DESCRIPTION — NOT FROM SIBLING CODE. This is the most common silent failure mode:
- read_file is for understanding STRUCTURE (where to put the new code, what indentation/imports/patterns the file uses) — NOT for copying logic. The new code's BEHAVIOR is specified in the task description.
- If the task says \`add a /version endpoint that returns { version: '1.0.0' }\`, your new_text MUST contain \`return { version: '1.0.0' }\`. It MUST NOT contain a clone of the /health handler's body just because /health was the nearest example you read.
- Read sibling routes/methods to learn HOW the file is wired (handler signature, registration style, helper imports). Then write the code the TASK asked for, with that wiring around it.
- A handler that echoes its neighbour's body instead of doing what was asked is wrong even if the file compiles. Validation will not necessarily catch it; the operator will.

Rules:
- Match the project's conventions: test framework, module type, .js suffix in imports for NodeNext, strict mode, indentation style.
- Follow the repo-map provided in context — do NOT reference symbols, files, or methods that aren't listed there (or that you create in this same step).
- Keep changes minimal. Don't refactor or "improve" code that the step didn't ask about.
- For new files in TypeScript projects: source files must be .ts (or .tsx), but imports use the .js suffix per NodeNext.
- NEVER write placeholder comments like "// Existing code…" or "// TODO". Either include the real code or omit the line.
- For Fastify: hooks take (request, reply) only — no payload/done/next. Use reply.elapsedTime for request duration. Use app.addHook("onResponse", ...) for response logging (not onRequest).
- Test files are NOT your responsibility for production-code steps. The TesterAgent runs separately. Do not edit __tests__/ files unless the step explicitly says to.

SCOPE DISCIPLINE:
- Write only to paths the task description names. read_file is always free.
- If the dispatcher rejects a write ("path X is not named in the task"), the path you tried isn't in scope — focus the change on a path that IS in scope, or proceed without that auxiliary edit. The user-message at the start lists "Allowed write targets" explicitly. Use those.
- Don't touch project configuration (package.json, tsconfig.json, vitest config, lockfiles, .env) unless the task literally names them.
- You MUST complete the substantive change requested in the task. Calling done() without making any of the requested edits is wrong unless the task is genuinely a no-op.

Output format: tool calls only. When you have completed the task, call done().`;

/**
 * Result of executing a single tool call against the WorkingSet.
 * `text` becomes the next `tool` role message content; `done` indicates the
 * model called `done()` and the loop should exit.
 */
interface ToolDispatchResult {
  text: string;
  done: boolean;
}

/**
 * Default policy used by tests / call sites that don't enforce scope. The
 * Agent supplies a real policy derived from the task description.
 */
const PERMISSIVE_POLICY: WritePolicy = {
  allowed: new Set(),
  forbiddenPatterns: [],
};

export function dispatchToolCall(
  call: ToolCall,
  ws: WorkingSet,
  policy: WritePolicy = PERMISSIVE_POLICY,
): ToolDispatchResult {
  const { name, arguments: args } = call.function;
  switch (name) {
    case 'read_file': {
      const filePath = String(args.path ?? '');
      if (!filePath) return { text: 'error: read_file requires a non-empty "path" argument', done: false };
      const content = ws.read(filePath);
      if (content === null) return { text: `error: file does not exist: ${filePath}`, done: false };
      // Number lines for the model — makes replace_in_file coords unambiguous.
      const lines = content.split('\n');
      const numbered = lines
        .map((line, i) => `${String(i + 1).padStart(4, ' ')} | ${line}`)
        .join('\n');
      return { text: `# ${filePath} (${lines.length} lines)\n${numbered}`, done: false };
    }
    case 'replace_in_file': {
      const filePath = String(args.path ?? '');
      const startLine = Number(args.start_line);
      const endLine = Number(args.end_line);
      const newText = typeof args.new_text === 'string' ? args.new_text : '';
      if (!filePath) return { text: 'error: replace_in_file requires "path"', done: false };
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
        return { text: 'error: start_line and end_line must be integers', done: false };
      }
      const allow = isWriteAllowed(filePath, policy);
      if (!allow.ok) return { text: `error: ${allow.reason}`, done: false };
      const r = ws.replace(filePath, startLine, endLine, newText);
      if (!r.ok) return { text: `error: ${r.error}`, done: false };
      return {
        text: `ok: replaced lines ${startLine}-${endLine} in ${filePath}`,
        done: false,
      };
    }
    case 'create_file': {
      const filePath = String(args.path ?? '');
      const content = typeof args.content === 'string' ? args.content : '';
      if (!filePath) return { text: 'error: create_file requires "path"', done: false };
      const allow = isWriteAllowed(filePath, policy);
      if (!allow.ok) return { text: `error: ${allow.reason}`, done: false };
      const r = ws.create(filePath, content);
      if (!r.ok) return { text: `error: ${r.error}`, done: false };
      return { text: `ok: created ${filePath}`, done: false };
    }
    case 'delete_file': {
      const filePath = String(args.path ?? '');
      if (!filePath) return { text: 'error: delete_file requires "path"', done: false };
      const allow = isWriteAllowed(filePath, policy);
      if (!allow.ok) return { text: `error: ${allow.reason}`, done: false };
      const r = ws.delete(filePath);
      if (!r.ok) return { text: `error: ${r.error}`, done: false };
      return { text: `ok: deleted ${filePath}`, done: false };
    }
    case 'done': {
      return { text: 'ok: changes finalized', done: true };
    }
    default:
      return { text: `error: unknown tool "${name}"`, done: false };
  }
}

export class ToolCallingCoderAgent {
  name = 'Coder(tool-calling)';
  role: ModelRole = 'coder';
  private router: ModelRouter;

  constructor(router: ModelRouter) {
    this.router = router;
  }

  async execute(
    stepDescription: string,
    context: string,
    taskMode: TaskMode,
    projectRoot: string,
    onFileReady?: FileReadyCallback,
  ): Promise<CoderOutput> {
    const ws = new WorkingSet(projectRoot);

    // Build the write policy from the step description. Anything the operator
    // mentions by path is in scope; everything else (especially configs) is
    // refused at dispatch time. This is the v1.30.1 fix for scope creep
    // observed on the v1.30 rag-system benchmark (model wiped package.json
    // and created untracked vitest-setup.ts on tasks that named neither).
    const allowed = extractAllowedPaths(stepDescription);
    const policy: WritePolicy = {
      allowed,
      forbiddenPatterns: ALWAYS_FORBIDDEN_PATTERNS,
    };

    const scopeLine =
      allowed.size > 0
        ? `Allowed write targets (only these): ${[...allowed].join(', ')}`
        : `Allowed write targets: any file (no explicit paths in task)`;

    const messages: ToolLoopMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `Step: ${stepDescription}\n\n` +
          `${scopeLine}\n\n` +
          `Project context:\n${context}\n\n` +
          `Now perform the change by calling tools. Always read_file before replace_in_file. Call done() when finished.`,
      },
    ];

    const ctx = currentTaskContext();
    let toolCallsExecuted = 0;
    let doneCalled = false;
    const emittedFilesByPath = new Set<string>();

    for (let round = 0; round < MAX_TOOL_CALLS && !doneCalled; round++) {
      const response = await this.router.routeWithTools(this.role, messages, TOOL_DEFINITIONS, taskMode);
      const calls = response.toolCalls ?? [];

      if (calls.length === 0) {
        // Model wrote prose instead of calling tools. Nudge once with an
        // explicit reminder, otherwise treat as an early exit.
        if (round === 0) {
          messages.push({ role: 'assistant', content: response.content });
          messages.push({
            role: 'user',
            content:
              'You did not call any tool. To make changes you MUST call read_file/replace_in_file/create_file/delete_file. Call tools now, or call done() if there is nothing to do.',
          });
          continue;
        }
        break;
      }

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

        // Per-file ready signal. The patch-based Coder uses `coder_file_ready`
        // events for streaming UX; tool-calling reproduces the same so SSE
        // clients (VSCode extension, Cline) get the same per-file beats. We
        // emit directly via taskEvents instead of going through the
        // partial-json-shaped onFileReady callback, because tool-calling
        // doesn't carry partial-file content (the WorkingSet does).
        if (
          ctx &&
          (call.function.name === 'create_file' || call.function.name === 'replace_in_file')
        ) {
          const filePath = String(call.function.arguments.path ?? '');
          if (filePath && !emittedFilesByPath.has(filePath) && result.text.startsWith('ok')) {
            emittedFilesByPath.add(filePath);
            const wsContent = ws.read(filePath) ?? '';
            taskEvents.emitEvent({
              taskId: ctx.taskId,
              type: 'coder_file_ready',
              message: `Coder produced ${filePath}`,
              data: {
                ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
                path: filePath,
                action: call.function.name === 'create_file' ? 'create' : 'modify',
                size: wsContent.length,
                index: emittedFilesByPath.size - 1,
              },
            });
          }
        }
        // Underscore-prefix to satisfy unused-param check; the hook is reserved
        // for parity with the patch-based Coder API.
        void onFileReady;

        if (result.done) {
          doneCalled = true;
          break;
        }
      }
    }

    if (toolCallsExecuted >= MAX_TOOL_CALLS && !doneCalled) {
      logger.warn(
        { agent: this.name, toolCalls: toolCallsExecuted },
        'Tool-calling Coder hit MAX_TOOL_CALLS limit without calling done()',
      );
    }

    const files: FileChange[] = ws.toFileChanges();
    if (files.length === 0) {
      logger.warn({ agent: this.name }, 'Tool-calling Coder produced no file changes');
    }

    return { files };
  }
}
