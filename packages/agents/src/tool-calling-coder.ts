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

Rules:
- Match the project's conventions: test framework, module type, .js suffix in imports for NodeNext, strict mode, indentation style.
- Follow the repo-map provided in context — do NOT reference symbols, files, or methods that aren't listed there (or that you create in this same step).
- Keep changes minimal. Don't refactor or "improve" code that the step didn't ask about.
- For new files in TypeScript projects: source files must be .ts (or .tsx), but imports use the .js suffix per NodeNext.
- NEVER write placeholder comments like "// Existing code…" or "// TODO". Either include the real code or omit the line.
- For Fastify: hooks take (request, reply) only — no payload/done/next. Use reply.elapsedTime for request duration. Use app.addHook("onResponse", ...) for response logging (not onRequest).
- Test files are NOT your responsibility for production-code steps. The TesterAgent runs separately. Do not edit __tests__/ files unless the step explicitly says to.

Output format: tool calls only. When you have nothing more to do, call done().`;

/**
 * Result of executing a single tool call against the WorkingSet.
 * `text` becomes the next `tool` role message content; `done` indicates the
 * model called `done()` and the loop should exit.
 */
interface ToolDispatchResult {
  text: string;
  done: boolean;
}

export function dispatchToolCall(call: ToolCall, ws: WorkingSet): ToolDispatchResult {
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
      const r = ws.create(filePath, content);
      if (!r.ok) return { text: `error: ${r.error}`, done: false };
      return { text: `ok: created ${filePath}`, done: false };
    }
    case 'delete_file': {
      const filePath = String(args.path ?? '');
      if (!filePath) return { text: 'error: delete_file requires "path"', done: false };
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
    const messages: ToolLoopMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `Step: ${stepDescription}\n\n` +
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
        const result = dispatchToolCall(call, ws);
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
