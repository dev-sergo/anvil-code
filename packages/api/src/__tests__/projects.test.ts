import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';

vi.mock('@rag-system/shared', async () => {
  const actual = await vi.importActual<typeof import('@rag-system/shared')>('@rag-system/shared');
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('@fastify/rate-limit', () => ({ default: async () => undefined }));

// Stub HNSW so the lazy GraphRetriever creation doesn't load the native binding
vi.mock('hnswlib-node', () => ({
  HierarchicalNSW: class {
    initIndex(): void {}
    resizeIndex(): void {}
    addPoint(): void {}
    searchKnn(): { neighbors: number[]; distances: number[] } { return { neighbors: [], distances: [] }; }
    writeIndexSync(): void {}
    readIndexSync(): void {}
    markDelete(): void {}
  },
}));

const { ProjectRegistry } = await import('@rag-system/memory');
const { ProjectManager } = await import('@rag-system/agents');
const { MemoryQueue } = await import('@rag-system/job-system');
const { buildServer } = await import('../server.js');

interface FastifyApp {
  listen(opts: { port: number; host: string }): Promise<string>;
  close(): Promise<void>;
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('API project endpoints + per-project task routing', () => {
  let tmpDir: string;
  let app: FastifyApp;
  let baseUrl: string;
  let registry: InstanceType<typeof ProjectRegistry>;
  let projects: InstanceType<typeof ProjectManager>;
  let defaultProjectId: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-projects-'));
    process.env.DATA_ROOT = path.join(tmpDir, 'data');

    const projectA = path.join(tmpDir, 'proj-a');
    fs.mkdirSync(projectA);

    registry = new ProjectRegistry(path.join(tmpDir, 'registry.db'));
    projects = new ProjectManager(registry, {} as never);
    const def = registry.register(projectA, 'Project A');
    defaultProjectId = def.id;
    await projects.get(def.id);

    const queue = new MemoryQueue();
    app = buildServer({ queue, registry, projects, defaultProjectId }) as unknown as FastifyApp;
    const addr = await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = addr.replace(/\/+$/, '');
  });

  afterEach(async () => {
    await app.close();
    projects.closeAll();
    registry.close();
    delete process.env.DATA_ROOT;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /projects returns the auto-registered default', async () => {
    const res = await fetch(`${baseUrl}/projects`);
    const json = await res.json() as { projects: Array<{ id: string; name: string }> };
    expect(json.projects).toHaveLength(1);
    expect(json.projects[0].id).toBe(defaultProjectId);
    expect(json.projects[0].name).toBe('Project A');
  });

  it('POST /project registers a new project with derived id', async () => {
    const projectB = path.join(tmpDir, 'proj-b');
    fs.mkdirSync(projectB);
    const { status, body } = await postJson(`${baseUrl}/project`, { root: projectB });
    expect(status).toBe(201);
    expect(typeof body.id).toBe('string');
    expect(body.name).toBe('proj-b');
    expect(registry.list()).toHaveLength(2);
  });

  it('POST /project is idempotent on the same root', async () => {
    const projectB = path.join(tmpDir, 'proj-b');
    fs.mkdirSync(projectB);
    const r1 = await postJson(`${baseUrl}/project`, { root: projectB });
    const r2 = await postJson(`${baseUrl}/project`, { root: projectB, name: 'Renamed' });
    expect((r1.body as { id: string }).id).toBe((r2.body as { id: string }).id);
    expect((r2.body as { name: string }).name).toBe('Renamed');
  });

  it('POST /task without `project` defaults to the auto-registered project', async () => {
    const { status, body } = await postJson(`${baseUrl}/task`, { task: 'do work' });
    expect(status).toBe(202);
    expect(body.project_id).toBe(defaultProjectId);
    expect(typeof body.task_id).toBe('string');
  });

  it('POST /task rejects unknown project id', async () => {
    const { status, body } = await postJson(`${baseUrl}/task`, { task: 'work', project: 'nope' });
    expect(status).toBe(404);
    expect(String(body.error)).toMatch(/not registered/);
  });

  it('GET /tasks returns only the tasks of the requested project', async () => {
    const projectB = path.join(tmpDir, 'proj-b');
    fs.mkdirSync(projectB);
    const reg = await postJson(`${baseUrl}/project`, { root: projectB });
    const projB = (reg.body as { id: string }).id;

    await postJson(`${baseUrl}/task`, { task: 'task in A' });
    await postJson(`${baseUrl}/task`, { task: 'task in B', project: projB });

    const a = await fetch(`${baseUrl}/tasks?project=${defaultProjectId}`);
    const aJson = await a.json() as { tasks: Array<{ description: string }> };
    expect(aJson.tasks.map(t => t.description)).toEqual(['task in A']);

    const b = await fetch(`${baseUrl}/tasks?project=${projB}`);
    const bJson = await b.json() as { tasks: Array<{ description: string }> };
    expect(bJson.tasks.map(t => t.description)).toEqual(['task in B']);
  });

  it('GET /task/:id resolves through the queue (which carries project_id)', async () => {
    const submitted = await postJson(`${baseUrl}/task`, { task: 'find me' });
    const taskId = submitted.body.task_id as string;
    const lookup = await fetch(`${baseUrl}/task/${taskId}`);
    const json = await lookup.json() as { project_id: string; status: string };
    expect(json.project_id).toBe(defaultProjectId);
    expect(json.status).toBe('queued');
  });
});
