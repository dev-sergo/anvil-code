import { describe, it, expect, vi } from 'vitest';
import { CoderAgent } from '../coder.js';
import type { ModelRole } from '@rag-system/shared';
import type { PartialFile } from '../partial-json.js';

/**
 * Build a router whose routeStream yields the given chunks with an optional
 * per-chunk delay, simulating real streaming latency.
 */
function makeRouter(chunks: string[], delayMs = 0) {
  return {
    routeStream: vi.fn().mockImplementation(async function* () {
      for (const chunk of chunks) {
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        yield { chunk, model: 'm', role: 'coder' as ModelRole };
      }
    }),
  };
}

describe('CoderAgent streaming', () => {
  it('invokes onFileReady for each file as soon as its object closes', async () => {
    const payload = JSON.stringify({
      files: [
        { path: 'a.ts', content: 'A', action: 'create' },
        { path: 'b.ts', content: 'B', action: 'modify' },
      ],
    });
    // Split so the two files arrive in separate chunks
    const router = makeRouter([
      payload.slice(0, payload.indexOf('}') + 1) + ',',
      payload.slice(payload.indexOf('}') + 2),
    ]);
    const agent = new CoderAgent(router as never);

    const ready: PartialFile[] = [];
    const out = await agent.execute('step', 'ctx', 'balanced', f => ready.push(f));

    expect(ready.map(f => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(out.files.map(f => f.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('still returns the full parsed output when no callback is passed', async () => {
    const payload = JSON.stringify({
      files: [{ path: 'x.ts', content: 'x', action: 'create' }],
    });
    const router = makeRouter([payload], 0);
    const agent = new CoderAgent(router as never);
    const out = await agent.execute('step', 'ctx', 'balanced');
    expect(out.files).toHaveLength(1);
    expect(out.files[0].path).toBe('x.ts');
  });

  it('handles a markdown-fenced stream', async () => {
    const body = JSON.stringify({
      files: [{ path: 'f.ts', content: 'z', action: 'create' }],
    });
    const fenced = '```json\n' + body + '\n```';
    const router = makeRouter([fenced]);
    const agent = new CoderAgent(router as never);

    const ready: PartialFile[] = [];
    const out = await agent.execute('step', 'ctx', 'balanced', f => ready.push(f));
    expect(ready).toHaveLength(1);
    expect(out.files[0].path).toBe('f.ts');
  });

  it('onFileReady is called before execute() resolves its promise', async () => {
    // Five small chunks spread over time; we track which chunk the callback
    // fired on vs. when the promise resolved.
    const payload = JSON.stringify({
      files: [
        { path: 'early.ts', content: 'first', action: 'create' },
        { path: 'late.ts', content: 'second', action: 'modify' },
      ],
    });
    const firstObjectEnd = payload.indexOf('}') + 1;
    const router = makeRouter([
      payload.slice(0, firstObjectEnd),       // chunk 0: enough to yield early.ts
      ',',
      payload.slice(firstObjectEnd + 1),      // chunk 2: rest, yields late.ts
    ], 20);
    const agent = new CoderAgent(router as never);

    const timeline: Array<{ type: 'ready' | 'resolved'; path?: string; at: number }> = [];
    const start = Date.now();

    const promise = agent.execute('step', 'ctx', 'balanced', f => {
      timeline.push({ type: 'ready', path: f.path, at: Date.now() - start });
    }).then(() => { timeline.push({ type: 'resolved', at: Date.now() - start }); });

    await promise;

    // early.ts must have been "ready" strictly before the promise resolved
    const earlyReady = timeline.find(e => e.type === 'ready' && e.path === 'early.ts');
    const resolved = timeline.find(e => e.type === 'resolved');
    expect(earlyReady).toBeDefined();
    expect(resolved).toBeDefined();
    expect(earlyReady!.at).toBeLessThan(resolved!.at);
  });
});
