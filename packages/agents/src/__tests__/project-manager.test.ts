import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';

vi.mock('@rag-system/shared', async () => {
  const actual = await vi.importActual<typeof import('@rag-system/shared')>('@rag-system/shared');
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    config: { ...actual.config, JOB_MAX_RETRIES: 1 },
  };
});

// HNSW native binding is slow — stub it.
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
const { ProjectManager } = await import('../project-manager.js');

describe('ProjectManager', () => {
  let tmpDir: string;
  let registry: InstanceType<typeof ProjectRegistry>;
  let manager: InstanceType<typeof ProjectManager>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-manager-'));
    process.env.DATA_ROOT = path.join(tmpDir, 'data');
    registry = new ProjectRegistry(path.join(tmpDir, 'registry.db'));
    manager = new ProjectManager(registry, {} as never);
  });

  afterEach(() => {
    manager.closeAll();
    registry.close();
    delete process.env.DATA_ROOT;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws when fetching a context for an unregistered project', async () => {
    await expect(manager.get('does-not-exist')).rejects.toThrow(/not registered/);
  });

  it('lazily creates a context on first get and caches it', async () => {
    const projA = path.join(tmpDir, 'proj-a'); fs.mkdirSync(projA);
    const a = registry.register(projA);

    const ctx1 = await manager.get(a.id);
    const ctx2 = await manager.get(a.id);
    expect(ctx1).toBe(ctx2);
    expect(ctx1.project.id).toBe(a.id);
    expect(manager.loaded()).toHaveLength(1);
  });

  it('different projects get isolated contexts (separate stores)', async () => {
    const projA = path.join(tmpDir, 'proj-a'); fs.mkdirSync(projA);
    const projB = path.join(tmpDir, 'proj-b'); fs.mkdirSync(projB);
    const a = registry.register(projA);
    const b = registry.register(projB);

    const ctxA = await manager.get(a.id);
    const ctxB = await manager.get(b.id);
    expect(ctxA).not.toBe(ctxB);
    expect(ctxA.store).not.toBe(ctxB.store);

    // Saving a task in A must not appear in B
    ctxA.store.saveTask({ id: 'task-1', description: 'in A', status: 'queued' });
    expect(ctxA.store.getTask('task-1')).toBeDefined();
    expect(ctxB.store.getTask('task-1')).toBeUndefined();
  });

  it('closeContext tears down resources but keeps the project in registry', async () => {
    const projA = path.join(tmpDir, 'proj-a'); fs.mkdirSync(projA);
    const a = registry.register(projA);
    await manager.get(a.id);
    expect(manager.loaded()).toHaveLength(1);

    manager.closeContext(a.id);
    expect(manager.loaded()).toHaveLength(0);
    expect(registry.get(a.id)).toBeDefined();
  });

  it('closeAll closes every loaded context', async () => {
    const a = registry.register(path.join(tmpDir, 'a'));
    fs.mkdirSync(path.join(tmpDir, 'a'), { recursive: true });
    const b = registry.register(path.join(tmpDir, 'b'));
    fs.mkdirSync(path.join(tmpDir, 'b'), { recursive: true });
    await manager.get(a.id);
    await manager.get(b.id);
    expect(manager.loaded()).toHaveLength(2);

    manager.closeAll();
    expect(manager.loaded()).toHaveLength(0);
  });

  it('get touches lastAccessedAt on every call', async () => {
    const projA = path.join(tmpDir, 'proj-a'); fs.mkdirSync(projA);
    const a = registry.register(projA);
    const before = registry.get(a.id)!.lastAccessedAt;
    await new Promise(r => setTimeout(r, 5));
    await manager.get(a.id);
    const after = registry.get(a.id)!.lastAccessedAt;
    expect(after).toBeGreaterThan(before);
  });
});
