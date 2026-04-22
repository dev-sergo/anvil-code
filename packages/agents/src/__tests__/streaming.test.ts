import { describe, it, expect, beforeEach, vi } from 'vitest';
import { taskEvents, withTaskContext } from '@rag-system/shared';
import type { TaskEvent } from '@rag-system/shared';
import { BaseAgent } from '../base-agent.js';
import type { ModelRole } from '@rag-system/shared';

class DummyAgent extends BaseAgent {
  name = 'Dummy';
  role: ModelRole = 'planner';
  systemPrompt = 'sys';
  async run(): Promise<string> {
    return this.callLLM('hello', 'balanced');
  }
}

function makeRouter(chunks: string[]) {
  return {
    routeStream: vi.fn().mockImplementation(async function* () {
      for (const chunk of chunks) {
        yield { chunk, model: 'm', role: 'planner' as ModelRole };
        // Force a microtask boundary so the throttle check actually sees time passing
        await new Promise(r => setTimeout(r, 0));
      }
    }),
  };
}

describe('BaseAgent streaming', () => {
  beforeEach(() => {
    taskEvents.clearHistory('s-task');
    taskEvents.removeAllListeners('task:s-task');
  });

  it('returns the full concatenated content', async () => {
    const router = makeRouter(['Hello', ' ', 'world', '!']);
    const agent = new DummyAgent(router as never);
    const out = await agent.run();
    expect(out).toBe('Hello world!');
  });

  it('emits agent_stream events on the per-task channel when context is set', async () => {
    const events: TaskEvent[] = [];
    taskEvents.on('task:s-task', e => events.push(e));

    // Many tiny chunks with delays so the throttle (~120 ms) lets multiple flushes happen.
    const chunks = ['a', 'b', 'c', 'd', 'e'];
    const router = {
      routeStream: vi.fn().mockImplementation(async function* () {
        for (const chunk of chunks) {
          yield { chunk, model: 'm', role: 'planner' as ModelRole };
          await new Promise(r => setTimeout(r, 150));
        }
      }),
    };
    const agent = new DummyAgent(router as never);

    const out = await withTaskContext({ taskId: 's-task', stepId: 'step-1' }, () => agent.run());
    expect(out).toBe('abcde');

    const streamEvents = events.filter(e => e.type === 'agent_stream');
    expect(streamEvents.length).toBeGreaterThan(0);
    // Concatenated chunk fields equal the full output (no chunks are dropped — only batched)
    const reconstructed = streamEvents.map(e => (e.data as { chunk: string }).chunk).join('');
    expect(reconstructed).toBe('abcde');
    // Each event carries the agent name, role, totalLen, and stepId from context
    for (const e of streamEvents) {
      const d = e.data as { agent: string; role: string; totalLen: number; stepId: string };
      expect(d.agent).toBe('Dummy');
      expect(d.role).toBe('planner');
      expect(d.stepId).toBe('step-1');
      expect(d.totalLen).toBeGreaterThan(0);
    }
  });

  it('emits no agent_stream events when called outside a task context', async () => {
    const handler = vi.fn();
    taskEvents.on('event', handler);

    const router = makeRouter(['no', ' ', 'context']);
    const agent = new DummyAgent(router as never);
    const out = await agent.run();
    expect(out).toBe('no context');

    const seen = handler.mock.calls.map(c => (c[0] as TaskEvent).type);
    expect(seen).not.toContain('agent_stream');
    taskEvents.off('event', handler);
  });

  it('agent_stream events are NOT replayed in history (transient)', async () => {
    const router = {
      routeStream: vi.fn().mockImplementation(async function* () {
        yield { chunk: 'x', model: 'm', role: 'planner' as ModelRole };
        await new Promise(r => setTimeout(r, 200));
        yield { chunk: 'y', model: 'm', role: 'planner' as ModelRole };
      }),
    };
    const agent = new DummyAgent(router as never);
    await withTaskContext({ taskId: 's-task' }, () => agent.run());
    expect(taskEvents.getHistory('s-task').filter(e => e.type === 'agent_stream')).toHaveLength(0);
  });
});
