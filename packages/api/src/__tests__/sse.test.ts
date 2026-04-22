import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import { taskEvents } from '@rag-system/shared';

// Make sure the rate limiter doesn't trip during tests
vi.mock('@fastify/rate-limit', () => ({
  default: async () => undefined,
}));

const { buildServer } = await import('../server.js');

interface FastifyServer {
  listen(opts: { port: number; host: string }): Promise<string>;
  close(): Promise<void>;
  server: http.Server;
}

function fakeQueue() {
  return {
    enqueue: vi.fn().mockReturnValue({ id: 'tsk-1' }),
    getJob: vi.fn().mockReturnValue(undefined),
  };
}

function fakeStore() {
  return {
    saveTask: vi.fn(),
    getTask: vi.fn().mockReturnValue(undefined),
    listTasks: vi.fn().mockReturnValue([]),
  };
}

async function readSseFrames(url: string, expectedTypes: string[], timeoutMs = 3_000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const seen: string[] = [];
    const req = http.get(url, res => {
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`SSE timeout, saw: ${seen.join(',')}`));
      }, timeoutMs);
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        const matches = chunk.matchAll(/^event: (\S+)$/gm);
        for (const m of matches) {
          seen.push(m[1]);
          if (expectedTypes.every(t => seen.includes(t))) {
            clearTimeout(timer);
            req.destroy();
            resolve(seen);
            return;
          }
        }
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve(seen);
      });
      res.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
    });
    req.on('error', reject);
  });
}

describe('GET /task/:id/stream', () => {
  let app: FastifyServer;
  let baseUrl: string;

  beforeEach(async () => {
    taskEvents.clearHistory('tsk-stream');
    taskEvents.removeAllListeners('task:tsk-stream');
    app = buildServer(fakeQueue() as never, fakeStore() as never) as unknown as FastifyServer;
    const addr = await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = addr.replace(/\/+$/, '');
  });

  afterEach(async () => {
    await app.close();
  });

  it('replays history then streams live events until terminal', async () => {
    // 1 history event before client connects
    taskEvents.emitEvent({ taskId: 'tsk-stream', type: 'queued' });

    const ssePromise = readSseFrames(`${baseUrl}/task/tsk-stream/stream`, ['queued', 'plan', 'done']);

    // Give the SSE handler a tick to attach its listener
    await new Promise(r => setTimeout(r, 50));

    taskEvents.emitEvent({ taskId: 'tsk-stream', type: 'plan' });
    taskEvents.emitEvent({ taskId: 'tsk-stream', type: 'done', message: 'finished' });

    const frames = await ssePromise;
    expect(frames).toContain('queued');
    expect(frames).toContain('plan');
    expect(frames).toContain('done');
  }, 5_000);

  it('closes immediately when task already finished before subscribe', async () => {
    taskEvents.emitEvent({ taskId: 'tsk-stream', type: 'queued' });
    taskEvents.emitEvent({ taskId: 'tsk-stream', type: 'done' });

    const frames = await readSseFrames(`${baseUrl}/task/tsk-stream/stream`, ['queued', 'done']);
    expect(frames).toEqual(['queued', 'done']);
  }, 5_000);
});
