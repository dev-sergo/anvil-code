import { z } from 'zod';
import { ModelRouter } from '@rag-system/model-router';
import { ModelRole, AgentMessage, logger, taskEvents, currentTaskContext } from '@rag-system/shared';
import { tryParseJsonTolerant } from './json-repair.js';

// Throttle agent_stream events: don't emit more than once per ~120 ms even if Ollama
// sends tokens faster — SSE clients can keep up but the event bus shouldn't churn.
const STREAM_FLUSH_MS = 120;

export abstract class BaseAgent {
  abstract name: string;
  abstract role: ModelRole;
  abstract systemPrompt: string;

  protected router: ModelRouter;

  constructor(router: ModelRouter) {
    this.router = router;
  }

  /**
   * Streaming primitive: yields raw model deltas and emits throttled `agent_stream`
   * events to the task bus. Use this when the caller wants to react to partial
   * output (e.g. CoderAgent's incremental file-ready callback).
   */
  protected async *streamLLM(
    prompt: string,
    taskMode?: 'fast'|'balanced'|'deep',
    jsonMode: boolean = false,
  ): AsyncIterable<string> {
    const messages: AgentMessage[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: prompt }
    ];

    const ctx = currentTaskContext();
    let totalLen = 0;
    let pending = '';
    let lastFlush = Date.now();

    const flush = (force: boolean) => {
      if (!ctx || !pending) return;
      const now = Date.now();
      if (!force && now - lastFlush < STREAM_FLUSH_MS) return;
      taskEvents.emitEvent({
        taskId: ctx.taskId,
        type: 'agent_stream',
        data: {
          agent: this.name,
          role: this.role,
          chunk: pending,
          totalLen,
          ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
        },
      });
      pending = '';
      lastFlush = now;
    };

    for await (const { chunk } of this.router.routeStream({
      role: this.role,
      messages,
      taskMode,
      options: { jsonMode },
    })) {
      totalLen += chunk.length;
      pending += chunk;
      flush(false);
      yield chunk;
    }
    flush(true);
  }

  protected async callLLM(prompt: string, taskMode?: 'fast'|'balanced'|'deep', jsonMode: boolean = false): Promise<string> {
    let full = '';
    for await (const chunk of this.streamLLM(prompt, taskMode, jsonMode)) full += chunk;
    return full;
  }

  protected parseJSON<T>(raw: string): T {
    const result = tryParseJsonTolerant<T>(raw);
    if (result.ok) {
      if (result.fixes.length > 0) {
        logger.warn(
          { agent: this.name, fixes: result.fixes },
          'LLM JSON required repair to parse',
        );
      }
      return result.value;
    }
    logger.error(
      { agent: this.name, error: result.error, tried: result.tried, raw },
      'Failed to parse LLM JSON output even after repair',
    );
    throw new Error(`LLM output parsing failed: ${result.error}`);
  }

  // Use structural typing to avoid Zod v3 input/output type inference issue with z.ZodSchema<T>
  protected parseAndValidate<T>(raw: string, schema: { parse(data: unknown): T }): T {
    const parsed = this.parseJSON<unknown>(raw);
    try {
      return schema.parse(parsed);
    } catch (e: unknown) {
      const msg = e instanceof z.ZodError
        ? e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')
        : String(e);
      logger.error({ error: msg, parsed }, `${this.name} output schema validation failed`);
      throw new Error(`${this.name} output invalid: ${msg}`);
    }
  }
}
