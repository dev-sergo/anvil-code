import type { ModelRouter } from '@rag-system/model-router';
import type { ToolLoopMessage } from '@rag-system/model-router';
import type { FileChange } from '@rag-system/shared';
import { logger, taskEvents, currentTaskContext } from '@rag-system/shared';
import { WorkingSet } from '../working-set.js';
import {
  TOOL_DEFINITIONS,
  dispatchToolCall,
  FILE_ARG_KEY,
  WRITE_EMITTING_TOOLS,
  PATHOLOGY_THRESHOLD,
  MAX_PATHOLOGY_STRIKES,
  type WritePolicy,
} from '../tool-calling-coder.js';
import { pruneHistory } from '../tool-calling-fixer.js';
import type { TaskAgentSpec, TaskAgentInput, TaskAgentOutput } from './spec.js';

/**
 * v1.32-c.1 — no-progress nudge. When the model calls done() with 0 successful
 * tool effects so far, this nudge is pushed once before allowing exit. Surfaces
 * the structural-first → done()-after-error bail observed on bench L1.1 #3 +
 * L4.1 #1/#2 (run 2026-05-04). Capped at 1 firing per runTaskAgent invocation.
 */
export const NO_PROGRESS_NUDGE =
  'You called done() with 0 successful edits — only errors so far. Don\'t give up after one structural-tool error. Common recoveries:\n' +
  '- Try replace_in_file with explicit start_line/end_line/new_text on the target file (line numbers shift after edits — read_file first to confirm current content).\n' +
  '- If add_route errored "no Fastify route calls in file", the route lives in a different file (e.g. routes/users.ts) — read that file and add the route there.\n' +
  '- If replace_method errored "class X not found", the target may be a const object literal — use replace_in_file on the relevant lines instead.\n' +
  'Only call done() once you have at least one successful tool result.';

/**
 * Shared tool-calling loop. v1.32-c replaces the duplicate Coder + Fixer
 * loops with this single implementation; behavior per kind is configured by
 * the supplied spec (FEATURE_SPEC / BUGFIX_SPEC / REFACTOR_SPEC).
 *
 * Loop invariants — must remain identical to the v1.32-d ToolCalling{Coder,
 * Fixer} loops so existing benches remain valid baselines:
 *  - WritePolicy = spec.buildAllowedSet(input) ∪ spec.forbiddenPatterns
 *  - per-round routeWithTools → dispatch each call → push messages
 *  - no-tool-calls nudge: 2 retries, then bail
 *  - pathology guard: same-fingerprint errors ≥ PATHOLOGY_THRESHOLD → nudge,
 *    after MAX_PATHOLOGY_STRIKES nudges → bail
 *  - per-file event emission gated by spec.emitPerFileEvents
 *  - history pruning each round end if spec.pruneHistory
 */
export async function runTaskAgent(
  spec: TaskAgentSpec,
  input: TaskAgentInput,
  router: ModelRouter,
  projectRoot: string,
): Promise<TaskAgentOutput> {
  const ws = new WorkingSet(projectRoot);

  const allowed = spec.buildAllowedSet(input);
  const policy: WritePolicy = {
    allowed,
    forbiddenPatterns: spec.forbiddenPatterns,
  };

  const messages: ToolLoopMessage[] = [
    { role: 'system', content: spec.systemPrompt },
    { role: 'user', content: spec.buildUserMessage(input, allowed) },
  ];

  const ctx = currentTaskContext();
  let toolCallsExecuted = 0;
  let doneCalled = false;
  let consecutiveNoToolCalls = 0;
  let consecutiveSameToolErrors = 0;
  let lastErrorFingerprint = '';
  let pathologyStrikes = 0;
  let pathologyBail = false;
  let successfulEdits = 0;
  let noProgressNudgeFired = false;
  const emittedFilesByPath = new Set<string>();

  for (let round = 0; round < spec.maxToolCalls && !doneCalled; round++) {
    const response = await router.routeWithTools(spec.agentRole, messages, TOOL_DEFINITIONS, input.taskMode);
    const calls = response.toolCalls ?? [];

    if (calls.length === 0) {
      consecutiveNoToolCalls++;
      if (consecutiveNoToolCalls >= 3) {
        logger.warn(
          { agent: spec.agentName },
          `${spec.agentName} emitted text-only response 3 times in a row; bailing`,
        );
        break;
      }
      const attempt = consecutiveNoToolCalls === 1 ? 1 : 2;
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: spec.noToolCallsNudge(attempt) });
      continue;
    }
    consecutiveNoToolCalls = 0;

    messages.push({ role: 'assistant', content: response.content, tool_calls: calls });

    for (const call of calls) {
      const argKey = FILE_ARG_KEY[call.function.name] ?? 'path';
      const callFilePath = String(call.function.arguments[argKey] ?? '');
      const vetoed = spec.interceptToolCall?.(call.function.name, callFilePath) ?? null;
      const result = vetoed !== null
        ? { text: vetoed, done: false }
        : dispatchToolCall(call, ws, policy);
      toolCallsExecuted++;
      messages.push({ role: 'tool', content: result.text, tool_name: call.function.name });

      const isError = result.text.startsWith('error:');
      if (isError) {
        const fp = `${call.function.name}:${callFilePath}`;
        if (fp === lastErrorFingerprint) {
          consecutiveSameToolErrors++;
        } else {
          consecutiveSameToolErrors = 1;
          lastErrorFingerprint = fp;
        }
        if (consecutiveSameToolErrors >= PATHOLOGY_THRESHOLD) {
          pathologyStrikes++;
          consecutiveSameToolErrors = 0;
          lastErrorFingerprint = '';
          if (pathologyStrikes >= MAX_PATHOLOGY_STRIKES) {
            logger.warn(
              { agent: spec.agentName, fingerprint: fp, totalCalls: toolCallsExecuted },
              `${spec.agentName} pathology guard: max strikes reached — bailing`,
            );
            pathologyBail = true;
            break;
          }
          messages.push({
            role: 'user',
            content: spec.pathologyNudge(call.function.name, callFilePath, PATHOLOGY_THRESHOLD),
          });
        }
      } else {
        consecutiveSameToolErrors = 0;
        lastErrorFingerprint = '';
        // v1.32-c.1: count tool calls that produced real file effects.
        // read_file and done don't count; everything else (replace_in_file,
        // create_file, add_route, replace_method, ... + delete_file) does.
        if (call.function.name !== 'read_file' && call.function.name !== 'done') {
          successfulEdits++;
        }
      }

      if (ctx) {
        taskEvents.emitEvent({
          taskId: ctx.taskId,
          type: 'agent_stream',
          data: {
            agent: spec.agentName,
            role: spec.agentRole,
            chunk: `[${call.function.name}] ${result.text.slice(0, 80)}`,
            totalLen: toolCallsExecuted,
            ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
          },
        });
      }

      if (
        spec.emitPerFileEvents
        && ctx
        && WRITE_EMITTING_TOOLS.has(call.function.name)
      ) {
        const argKey = FILE_ARG_KEY[call.function.name] ?? 'path';
        const filePath = String(call.function.arguments[argKey] ?? '');
        const isNoChange = result.text.startsWith('ok: no change');
        if (filePath && !emittedFilesByPath.has(filePath) && result.text.startsWith('ok') && !isNoChange) {
          emittedFilesByPath.add(filePath);
          const wsContent = ws.read(filePath) ?? '';
          taskEvents.emitEvent({
            taskId: ctx.taskId,
            type: 'coder_file_ready',
            message: `${spec.perFileEventLabel} ${filePath}`,
            data: {
              ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
              path: filePath,
              action: call.function.name === 'create_file' ? 'create' : 'modify',
              size: wsContent.length,
              index: emittedFilesByPath.size - 1,
              ...(spec.perFileEventSource ? { source: spec.perFileEventSource } : {}),
            },
          });
        }
      }

      if (result.done) {
        // v1.32-c.1: intercept premature done() — model bailing after errors
        // without having made any successful edit. Nudge once, allow exit on
        // second done() (legitimate give-up).
        if (successfulEdits === 0 && !noProgressNudgeFired) {
          messages.push({ role: 'user', content: NO_PROGRESS_NUDGE });
          noProgressNudgeFired = true;
          logger.info(
            { agent: spec.agentName, toolCalls: toolCallsExecuted },
            `${spec.agentName} no-progress nudge: blocked premature done()`,
          );
          break;
        }
        doneCalled = true;
        break;
      }
    }

    if (pathologyBail) break;

    if (spec.pruneHistory && pruneHistory(messages)) {
      logger.debug(
        { agent: spec.agentName, retainedMessages: messages.length },
        `Pruned ${spec.agentName} conversation history`,
      );
    }
  }

  if (toolCallsExecuted >= spec.maxToolCalls && !doneCalled) {
    logger.warn(
      { agent: spec.agentName, toolCalls: toolCallsExecuted },
      `${spec.agentName} hit MAX_TOOL_CALLS limit without calling done()`,
    );
  }

  const files: FileChange[] = ws.toFileChanges();
  if (files.length === 0) {
    logger.debug(
      { agent: spec.agentName },
      `${spec.agentName} produced no file changes`,
    );
  }

  return { files };
}
