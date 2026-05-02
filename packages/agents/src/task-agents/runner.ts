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
      const result = dispatchToolCall(call, ws, policy);
      toolCallsExecuted++;
      messages.push({ role: 'tool', content: result.text, tool_name: call.function.name });

      const isError = result.text.startsWith('error:');
      if (isError) {
        const argKey = FILE_ARG_KEY[call.function.name] ?? 'path';
        const fpPath = String(call.function.arguments[argKey] ?? '');
        const fp = `${call.function.name}:${fpPath}`;
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
            content: spec.pathologyNudge(call.function.name, fpPath, PATHOLOGY_THRESHOLD),
          });
        }
      } else {
        consecutiveSameToolErrors = 0;
        lastErrorFingerprint = '';
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
