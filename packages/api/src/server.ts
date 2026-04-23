import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import path from 'path';
import { logger, taskEvents } from '@rag-system/shared';
import type { TaskEvent } from '@rag-system/shared';
import type { MemoryQueue } from '@rag-system/job-system';
import type { ProjectRegistry } from '@rag-system/memory';
import type { ProjectManager } from '@rag-system/agents';
import { OllamaClient } from '@rag-system/model-router';

const CreateTaskSchema = z.object({
  task: z.string().min(1).max(2000),
  mode: z.enum(['fast', 'balanced', 'deep']).default('balanced'),
  project: z.string().optional(),
});

const RegisterProjectSchema = z.object({
  root: z.string().min(1),
  name: z.string().optional(),
});

export interface BuildServerDeps {
  queue: MemoryQueue;
  registry: ProjectRegistry;
  projects: ProjectManager;
  defaultProjectId: string;
}

export function buildServer(deps: BuildServerDeps) {
  const { queue, registry, projects, defaultProjectId } = deps;
  const app = Fastify({
    logger: false,
    bodyLimit: 65_536, // 64 KB
  });

  void app.register(cors, { origin: true });
  void app.register(rateLimit, {
    max: 60,          // 60 requests
    timeWindow: 60_000, // per minute
  });

  app.get('/health', async () => {
    const client = new OllamaClient();
    const ollamaOk = await client.healthCheck();
    return { status: 'ok', ollama: ollamaOk, uptime: Math.round(process.uptime()) };
  });

  app.post('/task', async (request, reply) => {
    const parsed = CreateTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request', details: parsed.error.issues });
    }

    const { task, mode, project: requested } = parsed.data;
    const projectId = requested ?? defaultProjectId;
    if (!registry.get(projectId)) {
      return reply.code(404).send({ error: `Project '${projectId}' not registered` });
    }

    const job = queue.enqueue(projectId, task, mode);

    const ctx = await projects.get(projectId);
    ctx.store.saveTask({
      id: job.id,
      description: task,
      status: 'queued',
      createdAt: new Date().toISOString(),
    });

    logger.info({ taskId: job.id, projectId, mode }, 'Task enqueued');
    taskEvents.emitEvent({
      taskId: job.id,
      type: 'queued',
      message: 'Task queued',
      data: { mode, projectId },
    });
    return reply.code(202).send({ task_id: job.id, project_id: projectId, status: 'queued' });
  });

  // ── Project endpoints ──
  app.get('/projects', async () => ({ projects: registry.list() }));

  app.get('/project/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = registry.get(id);
    if (!p) return reply.code(404).send({ error: 'Project not found' });
    return p;
  });

  app.post('/project', async (request, reply) => {
    const parsed = RegisterProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request', details: parsed.error.issues });
    }
    const absRoot = path.resolve(parsed.data.root);
    const project = registry.register(absRoot, parsed.data.name);
    logger.info({ projectId: project.id, root: absRoot }, 'Project registered');
    return reply.code(201).send(project);
  });

  app.get('/task/:id/stream', async (request, reply) => {
    const { id } = request.params as { id: string };

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: TaskEvent) => {
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Replay history so late subscribers don't miss earlier events
    for (const past of taskEvents.getHistory(id)) send(past);

    // If the task has already terminated, close immediately after history
    const history = taskEvents.getHistory(id);
    const last = history[history.length - 1];
    if (last && taskEvents.isTerminal(last)) {
      reply.raw.end();
      return;
    }

    const channel = `task:${id}`;
    const onEvent = (event: TaskEvent) => {
      send(event);
      if (taskEvents.isTerminal(event)) {
        cleanup();
        reply.raw.end();
      }
    };

    const heartbeat = setInterval(() => {
      reply.raw.write(': heartbeat\n\n');
    }, 15_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      taskEvents.off(channel, onEvent);
    };

    taskEvents.on(channel, onEvent);
    request.raw.on('close', cleanup);
  });

  app.get('/task/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const job = queue.getJob(id);
    if (job) {
      return {
        task_id: id,
        project_id: job.projectId,
        status: job.status,
        result: job.status === 'failed' ? (job.error ?? null) : null,
        logs: [],
      };
    }

    // Job not in queue cache — search the per-project stores. Only inspect
    // already-loaded contexts to avoid lazily opening every SQLite for an unknown id.
    for (const ctx of projects.loaded()) {
      const task = ctx.store.getTask(id);
      if (task) {
        return {
          task_id: id,
          project_id: ctx.project.id,
          status: task.status,
          result: task.result ?? null,
          logs: [],
        };
      }
    }
    return reply.code(404).send({ error: 'Task not found' });
  });

  app.get('/tasks', async (request) => {
    const projectId = (request.query as { project?: string }).project ?? defaultProjectId;
    if (!registry.get(projectId)) {
      return { tasks: [], project_id: projectId, error: 'Project not registered' };
    }
    const ctx = await projects.get(projectId);
    return { project_id: projectId, tasks: ctx.store.listTasks(50) };
  });

  return app;
}
