import { z } from 'zod';
import { ModelRouter } from '@rag-system/model-router';
import { ModelRole, AgentMessage, logger, taskEvents, currentTaskContext } from '@rag-system/shared';

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

  protected async callLLM(prompt: string, taskMode?: 'fast'|'balanced'|'deep', jsonMode: boolean = false): Promise<string> {
    const messages: AgentMessage[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: prompt }
    ];

    const ctx = currentTaskContext();
    let full = '';
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
          totalLen: full.length,
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
      full += chunk;
      pending += chunk;
      flush(false);
    }
    flush(true);

    return full;
  }

  protected parseJSON<T>(raw: string): T {
    try {
      let clean = raw.trim();
      if (clean.startsWith('```json')) clean = clean.substring(7);
      if (clean.startsWith('```')) clean = clean.substring(3);
      if (clean.endsWith('```')) clean = clean.substring(0, clean.length - 3);

      return JSON.parse(clean.trim()) as T;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error({ error: msg, raw }, 'Failed to parse LLM JSON output');
      throw new Error(`LLM output parsing failed: ${msg}`);
    }
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
