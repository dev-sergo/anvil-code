import { ModelRouter } from '@rag-system/model-router';
import type { ToolCall, ToolDefinition, ToolLoopMessage } from '@rag-system/model-router';
import type { ModelRole, TaskMode, FileChange } from '@rag-system/shared';
import { logger, taskEvents, currentTaskContext } from '@rag-system/shared';
import { WorkingSet } from './working-set.js';
import type { CoderOutput, FileReadyCallback } from './coder.js';
import {
  locateAddMethod,
  locateReplaceMethod,
  locateReplaceFunction,
  locateAddRoute,
  locateAddImport,
  locateAddExport,
} from './structural-edits.js';
import type { LocateResult } from './structural-edits.js';

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

export function isWriteAllowed(
  path: string,
  policy: WritePolicy,
  ws?: WorkingSet,
): { ok: true } | { ok: false; reason: string } {
  // Forbidden files override everything except an explicit task-description mention.
  // Reading a forbidden file does NOT grant write access — the absolute-ban
  // property is preserved so model can't sneak edits to package.json by reading it.
  for (const re of policy.forbiddenPatterns) {
    if (re.test(path) && !policy.allowed.has(path)) {
      return {
        ok: false,
        reason: `path "${path}" is in the project's protected configuration set (package.json, tsconfig, lockfiles, etc.) and is not named in the task — refusing to modify`,
      };
    }
  }
  // Permissive mode: no static allowlist enforcement, only forbidden patterns gate writes.
  if (policy.allowed.size === 0) return { ok: true };
  // Static allowlist hit.
  if (policy.allowed.has(path)) return { ok: true };
  // v1.32-a.1 dynamic scope: a file the model has explicitly read in the
  // current loop is granted write access. The read is a deliberate gesture
  // that says "I want to inspect this and possibly edit it." Forbidden
  // patterns above already excluded; normal source files unlock cleanly.
  if (ws?.hasOpened(path)) return { ok: true };
  return {
    ok: false,
    reason:
      `path "${path}" is not in scope: not named in the task and not opened via read_file in this loop. ` +
      `Statically allowed: [${[...policy.allowed].join(', ')}]. To edit this file, call read_file("${path}") first — the dispatcher then grants write access for the rest of this loop.`,
  };
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
      name: 'add_method',
      description:
        "Add a new method to a top-level class. Pass the FULL method declaration in `source` (modifiers + signature + body — e.g. `async getSize(): Promise<number> { return this.length; }`). The runtime locates the class by name, parses your source for the method name, and inserts the new method just before the class's closing brace with correct indentation. Errors if the class isn't found, the method already exists (use replace_method), or `source` doesn't parse as exactly one method.",
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Project-relative file path' },
          container: { type: 'string', description: 'Top-level class name to add the method to' },
          source: { type: 'string', description: 'Full method declaration: `<modifiers> <name>(<params>): <return> { <body> }`' },
        },
        required: ['file', 'container', 'source'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_method',
      description:
        "Rewrite the body+signature of an existing method on a top-level class. `source` is the full new method declaration (modifiers + signature + body); its method name must match `name`. Decorators/modifiers in source replace the previous ones. Leading jsdoc comments above the method are preserved (they sit on different lines outside the replace range). To rename, use delete_file/replace_in_file or remove + add_method.",
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Project-relative file path' },
          container: { type: 'string', description: 'Top-level class name owning the method' },
          name: { type: 'string', description: 'Existing method name to replace' },
          source: { type: 'string', description: 'Full new method declaration; method name must match `name`' },
        },
        required: ['file', 'container', 'name', 'source'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_function',
      description:
        "Rewrite a top-level FunctionDeclaration. `source` is the full new function declaration; its function name must match `name`. Targets the first declaration with that name — for overloads (signature + implementation), the implementation body should be edited via replace_in_file.",
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Project-relative file path' },
          name: { type: 'string', description: 'Existing top-level function name to replace' },
          source: { type: 'string', description: 'Full new function declaration: `function <name>(...) { ... }` (or `export function ...`)' },
        },
        required: ['file', 'name', 'source'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_route',
      description:
        "Add a Fastify-style route. The runtime finds the existing routes (app.get/post/...) in the file, copies the instance name (app/server/fastify/instance/route) and indent style, and inserts a new `<instance>.<method>('<path>', async <params> => { <body> });` after the last existing route. `body` is the handler body's statements only (no surrounding `async () => {}`). The file must already have at least one route — bootstrap a brand-new server with create_file or replace_in_file.",
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Project-relative file path containing existing Fastify routes' },
          http_method: {
            type: 'string',
            description: 'HTTP method',
            enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
          },
          route_path: { type: 'string', description: "URL path (e.g. '/version'). Must not contain a single quote, backslash, or newline" },
          body: { type: 'string', description: 'Handler body — the statements that go inside `async (request, reply) => { ... }`' },
          params: { type: 'string', description: "Optional handler params override (default '(request, reply)'). Pass '()' for a no-arg handler" },
        },
        required: ['file', 'http_method', 'route_path', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_import',
      description:
        "Ensure the file imports the requested names from a module. Idempotent: if all requested names are already imported with matching type-only flag, returns success without changing the file. If an import from the same source exists and is compatible, the existing line is replaced with a merged import. Otherwise a new import is appended after the last existing import (or at the top of the file). Doesn't support namespace imports (`import * as ns`).",
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Project-relative file path' },
          source: { type: 'string', description: "Module specifier (e.g. 'pino', './lib.js')" },
          names: {
            type: 'array',
            items: { type: 'string' },
            description: 'Named imports to add (e.g. ["FastifyInstance", "FastifyRequest"])',
          },
          default_name: { type: 'string', description: 'Optional default import name (e.g. "pino" for `import pino from \'pino\';`)' },
          type_only: { type: 'boolean', description: 'If true, render `import type { ... }`. Must match the existing import\'s type-only flag if there is one' },
        },
        required: ['file', 'source'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_export',
      description:
        "Add a top-level export to the file. `source` is the full statement (e.g. `export const X = 42;`, `export function foo() { ... }`, `export type T = ...`, `export { x }`). Inserted after the last existing top-level export, else after the last import, else at the top of the file. Use this when you need to introduce a brand-new exported symbol — to modify an existing exported symbol, use replace_function/replace_method/replace_in_file.",
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Project-relative file path' },
          source: { type: 'string', description: 'Full export statement, e.g. `export const FOO = 42;`' },
        },
        required: ['file', 'source'],
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

/**
 * Tool-call argument key holding the project-relative file path. Most tools
 * use `path`; structural tools use `file` to disambiguate from `route_path`
 * and similar nested URL/module-path arguments. The dispatcher and the per-
 * file event emitter both consult this map to extract the path consistently.
 */
const FILE_ARG_KEY: Record<string, string> = {
  read_file: 'path',
  replace_in_file: 'path',
  create_file: 'path',
  delete_file: 'path',
  add_method: 'file',
  replace_method: 'file',
  replace_function: 'file',
  add_route: 'file',
  add_import: 'file',
  add_export: 'file',
};

/**
 * Tools that mutate file content (used to emit per-file `coder_file_ready`
 * events for SSE clients). delete_file is excluded — clients track removals
 * separately via the final FileChange[] from toFileChanges().
 */
const WRITE_EMITTING_TOOLS = new Set([
  'create_file',
  'replace_in_file',
  'add_method',
  'replace_method',
  'replace_function',
  'add_route',
  'add_import',
  'add_export',
]);

const SYSTEM_PROMPT = `You are an expert Software Engineer working through tools.
Given a step description and project context, you implement the change by calling tools.

YOU CANNOT WRITE THE CODE DIRECTLY IN A REPLY. The only way to make changes is via tool calls.

STRUCTURAL TOOLS (PREFERRED for TypeScript/JavaScript edits):
These tools take symbol names instead of line coordinates and handle indentation for you. Always prefer them when the change fits.
- add_method(file, container, source) — add a new method to an existing class
- replace_method(file, container, name, source) — rewrite an existing method's signature+body
- replace_function(file, name, source) — rewrite a top-level function
- add_route(file, http_method, route_path, body) — add a Fastify route after the last existing one
- add_import(file, source, names?, default_name?, type_only?) — add or merge an import
- add_export(file, source) — add a new top-level export

LINE-COORDINATE TOOLS (fallback):
- read_file(path) — see actual current bytes with line numbers (use freely)
- replace_in_file(path, start_line, end_line, new_text) — line-range edit. Use ONLY when no structural tool fits — typically for non-source content (markdown, JSON, YAML, plain text) or unusual code shapes (single-line classes, decorators between import statements, etc.). Picking line coordinates for source code is fragile and has caused multiple categories of bugs in past benchmarks.
- create_file(path, content) — make a new file
- delete_file(path) — remove a file
- done() — signal completion

Workflow:
1. read_file the target if you need to see the current symbols/structure (e.g. existing class names, existing routes).
2. Pick the structural tool whose contract matches what you want to do. If no structural tool fits, fall back to replace_in_file.
3. For structural tools, the "source" you pass is the full declaration (modifiers + signature + body). The runtime re-indents it; you can write at column 0 if you prefer.
4. When a structural tool errors (e.g. "class X not found"), it usually means your assumption about the file is wrong. read_file again, fix the assumption, retry.
5. When the step is complete, call done() exactly once.

CRITICAL: line numbers shift after every edit. If you call any tool that mutates a file (add_method, add_import, replace_in_file, ...) and then need to call replace_in_file on the same file, you MUST read_file again first to see the new line numbers. Stale line coords from the original read are wrong after the file has been mutated, and a replace_in_file on stale coords corrupts the file.

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
- Write only to paths the task description names OR paths you have explicitly opened via read_file in this loop. read_file is always free, and a deliberate read grants write access for the rest of this loop ("read-grants-write" rule).
- If the dispatcher rejects a write with "not in scope: not named in the task and not opened via read_file" — call read_file on that path first, then retry the write. The read is your declared intent to edit.
- The user-message at the start lists "Allowed write targets" — those are the statically-allowed paths from the task. Anything else requires read_file first.
- Don't touch project configuration (package.json, tsconfig.json, vitest config, lockfiles, .env) — these stay forbidden even after read_file. The "absolute ban" is non-negotiable.
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

/**
 * Source-file extensions worth balance-checking. Picks JS/TS/JSX/TSX and a few
 * common siblings; skips json/yaml/md/etc. where braces don't have to balance
 * the same way (or are checked by their own parsers downstream).
 */
const BALANCE_CHECK_EXTS = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

interface Balance {
  curly: number;
  paren: number;
  square: number;
}

/**
 * Lightweight brace/paren/bracket balance checker for TS/JS source. String-
 * and comment-aware so braces inside strings (`"{"`) or comments (`/* { *\/`)
 * don't throw the count off. Not a full tokenizer — does NOT understand:
 *   - Template literal expressions (`${...}`) — treated as literal string content
 *   - JSX (returns may go negative on TSX with unmatched-looking JSX braces)
 *   - Regex literals (`/{}/`) — treated as division by braces, can miscount
 *
 * Designed to catch the structural-placement bug v1.30.4 surfaced (model
 * consumed a closing `});` in replace_in_file without restoring it). Common
 * failure modes — net-positive or net-negative curly/paren counts — are
 * caught reliably. Edge cases (regex, JSX) trade off for a fast,
 * dependency-free check that runs after every edit without slowing the loop.
 */
export function checkBraceBalance(content: string):
  | { ok: true; balance: Balance }
  | { ok: false; reason: string; balance: Balance } {
  const b: Balance = { curly: 0, paren: 0, square: 0 };

  enum State {
    Code,
    LineComment,    // //
    BlockComment,   // /* */
    SingleString,   // '...'
    DoubleString,   // "..."
    Backtick,       // `...`
  }
  let state = State.Code;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = i + 1 < content.length ? content[i + 1] : '';

    switch (state) {
      case State.LineComment:
        if (ch === '\n') state = State.Code;
        continue;
      case State.BlockComment:
        if (ch === '*' && next === '/') { state = State.Code; i++; }
        continue;
      case State.SingleString:
      case State.DoubleString:
      case State.Backtick: {
        if (ch === '\\') { i++; continue; } // skip escaped char
        const closer =
          state === State.SingleString ? "'" :
          state === State.DoubleString ? '"' : '`';
        if (ch === closer) state = State.Code;
        continue;
      }
      case State.Code:
        if (ch === '/' && next === '/') { state = State.LineComment; i++; continue; }
        if (ch === '/' && next === '*') { state = State.BlockComment; i++; continue; }
        if (ch === "'") { state = State.SingleString; continue; }
        if (ch === '"') { state = State.DoubleString; continue; }
        if (ch === '`') { state = State.Backtick; continue; }
        if (ch === '{') b.curly++;
        else if (ch === '}') b.curly--;
        else if (ch === '(') b.paren++;
        else if (ch === ')') b.paren--;
        else if (ch === '[') b.square++;
        else if (ch === ']') b.square--;

        // Early-exit on net-negative — closing without an opener mid-file
        // means the file is structurally broken right at this point.
        if (b.curly < 0) {
          return { ok: false, reason: `extra closing '}' near offset ${i}`, balance: b };
        }
        if (b.paren < 0) {
          return { ok: false, reason: `extra closing ')' near offset ${i}`, balance: b };
        }
        if (b.square < 0) {
          return { ok: false, reason: `extra closing ']' near offset ${i}`, balance: b };
        }
        break;
    }
  }

  if (b.curly !== 0 || b.paren !== 0 || b.square !== 0) {
    const parts: string[] = [];
    if (b.curly !== 0) parts.push(`${b.curly > 0 ? 'unclosed' : 'extra closing'} '${b.curly > 0 ? '{' : '}'}': net ${b.curly}`);
    if (b.paren !== 0) parts.push(`${b.paren > 0 ? 'unclosed' : 'extra closing'} '${b.paren > 0 ? '(' : ')'}': net ${b.paren}`);
    if (b.square !== 0) parts.push(`${b.square > 0 ? 'unclosed' : 'extra closing'} '${b.square > 0 ? '[' : ']'}': net ${b.square}`);
    return { ok: false, reason: parts.join(', '), balance: b };
  }
  return { ok: true, balance: b };
}

function shouldBalanceCheck(path: string): boolean {
  return BALANCE_CHECK_EXTS.test(path);
}

/**
 * Apply a structural edit (`add_method`, `replace_method`, ...) to a file.
 *
 * The locator function takes the current file content and returns either an
 * error or a StructuralEdit (insert / replace / noop). This helper:
 *  - validates path + write policy (same scope discipline as replace_in_file)
 *  - reads current content from the WorkingSet
 *  - runs the locator to get an edit
 *  - applies the edit via `ws.insertBefore` or `ws.replace`
 *  - runs the v1.30.5 brace-balance check + rollback as defense-in-depth
 *
 * AST-derived edits should always be balanced by construction, but if the
 * source the model passed had unmatched braces inside a string literal or
 * similar parser-confusing form, we still catch and roll back.
 */
function executeStructuralEdit(
  toolLabel: string,
  filePath: string,
  ws: WorkingSet,
  policy: WritePolicy,
  locate: (content: string) => LocateResult,
): ToolDispatchResult {
  if (!filePath) {
    return { text: `error: ${toolLabel} requires a non-empty "file" argument`, done: false };
  }
  const allow = isWriteAllowed(filePath, policy, ws);
  if (!allow.ok) return { text: `error: ${allow.reason}`, done: false };

  const content = ws.read(filePath);
  if (content === null) {
    return { text: `error: file does not exist: ${filePath}. Use create_file to make a new file`, done: false };
  }

  const located = locate(content);
  if (!located.ok) return { text: `error: ${located.error}`, done: false };

  const edit = located.edit;
  if (edit.kind === 'noop') {
    return { text: `ok: no change needed — ${edit.reason}`, done: false };
  }

  const balanceBefore = shouldBalanceCheck(filePath)
    ? { content, check: checkBraceBalance(content) }
    : null;

  const result =
    edit.kind === 'insert'
      ? ws.insertBefore(filePath, edit.line, edit.text)
      : ws.replace(filePath, edit.startLine, edit.endLine, edit.text);
  if (!result.ok) {
    return { text: `error: ${result.error}`, done: false };
  }

  if (balanceBefore && balanceBefore.check.ok) {
    const after = ws.read(filePath) ?? '';
    const balanceAfter = checkBraceBalance(after);
    if (!balanceAfter.ok) {
      ws.overwriteRaw(filePath, balanceBefore.content);
      return {
        text:
          `error: ${toolLabel} would leave ${filePath} structurally unbalanced: ${balanceAfter.reason}. ` +
          `The change was rolled back. The source you passed likely contains unmatched braces or quote-confusing content`,
        done: false,
      };
    }
  }

  return { text: `ok: ${toolLabel} applied to ${filePath}`, done: false };
}

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
      const allow = isWriteAllowed(filePath, policy, ws);
      if (!allow.ok) return { text: `error: ${allow.reason}`, done: false };

      // v1.30.5 — capture pre-edit content + balance for syntax verification.
      // If the edit makes a previously-balanced file structurally unbalanced,
      // we roll back and tell the model what went wrong. Catches the v1.30.4
      // failure mode where a replace consumed a closing `});` without
      // including a replacement, leaving a nested-handlers mess.
      const balanceBefore = shouldBalanceCheck(filePath)
        ? (() => {
            const before = ws.read(filePath);
            return before !== null ? { content: before, check: checkBraceBalance(before) } : null;
          })()
        : null;

      const r = ws.replace(filePath, startLine, endLine, newText);
      if (!r.ok) return { text: `error: ${r.error}`, done: false };

      if (balanceBefore && balanceBefore.check.ok) {
        const after = ws.read(filePath) ?? '';
        const balanceAfter = checkBraceBalance(after);
        if (!balanceAfter.ok) {
          // Roll the file back to its pre-edit state. The model retries with
          // adjusted line range, never seeing the broken intermediate state.
          ws.overwriteRaw(filePath, balanceBefore.content);
          return {
            text:
              `error: edit at lines ${startLine}-${endLine} would leave ${filePath} structurally unbalanced: ${balanceAfter.reason}. ` +
              `The change was rolled back. Adjust your line range or new_text — most likely you consumed a closing brace/paren without including a replacement.`,
            done: false,
          };
        }
      }

      return {
        text: `ok: replaced lines ${startLine}-${endLine} in ${filePath}`,
        done: false,
      };
    }
    case 'create_file': {
      const filePath = String(args.path ?? '');
      const content = typeof args.content === 'string' ? args.content : '';
      if (!filePath) return { text: 'error: create_file requires "path"', done: false };
      const allow = isWriteAllowed(filePath, policy, ws);
      if (!allow.ok) return { text: `error: ${allow.reason}`, done: false };

      // Same balance guard as replace_in_file — a brand-new TS/JS file should
      // ship with balanced braces. Saves Validator/Fixer cycles on obviously
      // malformed output.
      if (shouldBalanceCheck(filePath)) {
        const check = checkBraceBalance(content);
        if (!check.ok) {
          return {
            text:
              `error: cannot create ${filePath} — content is structurally unbalanced: ${check.reason}. ` +
              `Fix the braces/parens/brackets in the content you pass to create_file.`,
            done: false,
          };
        }
      }

      const r = ws.create(filePath, content);
      if (!r.ok) return { text: `error: ${r.error}`, done: false };
      return { text: `ok: created ${filePath}`, done: false };
    }
    case 'delete_file': {
      const filePath = String(args.path ?? '');
      if (!filePath) return { text: 'error: delete_file requires "path"', done: false };
      const allow = isWriteAllowed(filePath, policy, ws);
      if (!allow.ok) return { text: `error: ${allow.reason}`, done: false };
      const r = ws.delete(filePath);
      if (!r.ok) return { text: `error: ${r.error}`, done: false };
      return { text: `ok: deleted ${filePath}`, done: false };
    }
    case 'add_method': {
      const filePath = String(args.file ?? '');
      const container = String(args.container ?? '');
      const source = typeof args.source === 'string' ? args.source : '';
      if (!container) return { text: 'error: add_method requires "container" (the class name)', done: false };
      if (!source) return { text: 'error: add_method requires "source" (the full method declaration)', done: false };
      return executeStructuralEdit('add_method', filePath, ws, policy, c =>
        locateAddMethod(c, container, source),
      );
    }
    case 'replace_method': {
      const filePath = String(args.file ?? '');
      const container = String(args.container ?? '');
      const methodName = String(args.name ?? '');
      const source = typeof args.source === 'string' ? args.source : '';
      if (!container) return { text: 'error: replace_method requires "container"', done: false };
      if (!methodName) return { text: 'error: replace_method requires "name"', done: false };
      if (!source) return { text: 'error: replace_method requires "source"', done: false };
      return executeStructuralEdit('replace_method', filePath, ws, policy, c =>
        locateReplaceMethod(c, container, methodName, source),
      );
    }
    case 'replace_function': {
      const filePath = String(args.file ?? '');
      const fnName = String(args.name ?? '');
      const source = typeof args.source === 'string' ? args.source : '';
      if (!fnName) return { text: 'error: replace_function requires "name"', done: false };
      if (!source) return { text: 'error: replace_function requires "source"', done: false };
      return executeStructuralEdit('replace_function', filePath, ws, policy, c =>
        locateReplaceFunction(c, fnName, source),
      );
    }
    case 'add_route': {
      const filePath = String(args.file ?? '');
      const httpMethod = String(args.http_method ?? '');
      const routePath = String(args.route_path ?? '');
      const body = typeof args.body === 'string' ? args.body : '';
      const params = typeof args.params === 'string' ? args.params : undefined;
      if (!httpMethod) return { text: 'error: add_route requires "http_method"', done: false };
      if (!routePath) return { text: 'error: add_route requires "route_path"', done: false };
      if (!body) return { text: 'error: add_route requires "body" (the handler body)', done: false };
      return executeStructuralEdit('add_route', filePath, ws, policy, c =>
        locateAddRoute(c, httpMethod, routePath, body, params),
      );
    }
    case 'add_import': {
      const filePath = String(args.file ?? '');
      const source = String(args.source ?? '');
      const namesArg = args.names;
      const names = Array.isArray(namesArg) ? namesArg.filter((n): n is string => typeof n === 'string') : [];
      const defaultName = typeof args.default_name === 'string' && args.default_name ? args.default_name : undefined;
      const typeOnly = args.type_only === true;
      if (!source) return { text: 'error: add_import requires "source" (the module specifier)', done: false };
      return executeStructuralEdit('add_import', filePath, ws, policy, c =>
        locateAddImport(c, source, names, defaultName, typeOnly),
      );
    }
    case 'add_export': {
      const filePath = String(args.file ?? '');
      const source = typeof args.source === 'string' ? args.source : '';
      if (!source) return { text: 'error: add_export requires "source" (the full export statement)', done: false };
      return executeStructuralEdit('add_export', filePath, ws, policy, c =>
        locateAddExport(c, source),
      );
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
    // v1.32-a.3 — track consecutive text-only responses for retry-with-nudge.
    let consecutiveNoToolCalls = 0;
    const emittedFilesByPath = new Set<string>();

    for (let round = 0; round < MAX_TOOL_CALLS && !doneCalled; round++) {
      const response = await this.router.routeWithTools(this.role, messages, TOOL_DEFINITIONS, taskMode);
      const calls = response.toolCalls ?? [];

      if (calls.length === 0) {
        // v1.32-a.3 — symmetric with Fixer: up to 2 retries with progressively
        // stronger nudges. The earlier "or call done() if there is nothing to
        // do" gave too easy an escape hatch; on hard tasks the model would
        // produce a text-only response and bail without making any change.
        consecutiveNoToolCalls++;
        if (consecutiveNoToolCalls >= 3) {
          logger.warn(
            { agent: this.name },
            'Tool-calling Coder emitted text-only response 3 times in a row; bailing',
          );
          break;
        }
        const nudge = consecutiveNoToolCalls === 1
          ? `You responded with text but did not call any tool. Tools are the only way to make changes. Read the file the task references with read_file, then make the edit. Do that now — no preamble.`
          : `Still no tool call. Tools execute changes; text does nothing. Call read_file on the file the task names, then a structural edit (add_route / add_method / add_import / etc.) or replace_in_file. If the task is genuinely a no-op, call done() — but only as a tool call.`;
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

        // Per-file ready signal. The patch-based Coder uses `coder_file_ready`
        // events for streaming UX; tool-calling reproduces the same so SSE
        // clients (VSCode extension, Cline) get the same per-file beats. We
        // emit directly via taskEvents instead of going through the
        // partial-json-shaped onFileReady callback, because tool-calling
        // doesn't carry partial-file content (the WorkingSet does).
        // v1.31: extended to all writing tools (structural + line-coord) via
        // WRITE_EMITTING_TOOLS; the file-path key may be `path` (line-coord
        // tools) or `file` (structural tools), looked up via FILE_ARG_KEY.
        if (ctx && WRITE_EMITTING_TOOLS.has(call.function.name)) {
          const argKey = FILE_ARG_KEY[call.function.name] ?? 'path';
          const filePath = String(call.function.arguments[argKey] ?? '');
          // Skip noop results — add_import returns "ok: no change needed ..."
          // when everything is already imported, and we don't want a phantom
          // "Coder produced X" event for a file we didn't touch.
          const isNoChange = result.text.startsWith('ok: no change');
          if (filePath && !emittedFilesByPath.has(filePath) && result.text.startsWith('ok') && !isNoChange) {
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
