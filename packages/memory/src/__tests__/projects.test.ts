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

const { ProjectRegistry, projectPaths, deriveProjectId } = await import('../projects.js');

describe('ProjectRegistry', () => {
  let tmpDir: string;
  let dbPath: string;
  let registry: InstanceType<typeof ProjectRegistry>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-registry-'));
    dbPath = path.join(tmpDir, 'projects.db');
    registry = new ProjectRegistry(dbPath);
  });

  afterEach(() => {
    registry.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('register creates a project with derived id and basename as default name', () => {
    const root = path.join(tmpDir, 'my-app');
    fs.mkdirSync(root);
    const p = registry.register(root);
    expect(p.id).toBe(deriveProjectId(root));
    expect(p.name).toBe('my-app');
    expect(p.root).toBe(path.resolve(root));
    expect(p.createdAt).toBeGreaterThan(0);
  });

  it('register with a custom name uses it', () => {
    const p = registry.register(tmpDir, 'Pretty Name');
    expect(p.name).toBe('Pretty Name');
  });

  it('register is idempotent on the same root and updates lastAccessedAt', async () => {
    const p1 = registry.register(tmpDir);
    await new Promise(r => setTimeout(r, 5));
    const p2 = registry.register(tmpDir);
    expect(p2.id).toBe(p1.id);
    expect(p2.createdAt).toBe(p1.createdAt);
    expect(p2.lastAccessedAt).toBeGreaterThan(p1.lastAccessedAt);
  });

  it('register can update the display name without losing identity', () => {
    const p1 = registry.register(tmpDir, 'Original');
    const p2 = registry.register(tmpDir, 'Renamed');
    expect(p2.id).toBe(p1.id);
    expect(p2.name).toBe('Renamed');
  });

  it('list returns projects ordered by lastAccessedAt desc', async () => {
    const a = path.join(tmpDir, 'a'); fs.mkdirSync(a);
    const b = path.join(tmpDir, 'b'); fs.mkdirSync(b);
    registry.register(a);
    await new Promise(r => setTimeout(r, 5));
    registry.register(b);
    const list = registry.list();
    expect(list.map(p => p.name)).toEqual(['b', 'a']);
  });

  it('getByRoot returns the same project as get(deriveProjectId(root))', () => {
    const created = registry.register(tmpDir);
    expect(registry.getByRoot(tmpDir)?.id).toBe(created.id);
  });

  it('touch bumps lastAccessedAt', async () => {
    const p = registry.register(tmpDir);
    await new Promise(r => setTimeout(r, 5));
    registry.touch(p.id);
    const refreshed = registry.get(p.id)!;
    expect(refreshed.lastAccessedAt).toBeGreaterThan(p.lastAccessedAt);
  });

  it('unregister removes the project but keeps data on disk untouched', () => {
    const p = registry.register(tmpDir);
    expect(registry.unregister(p.id)).toBe(true);
    expect(registry.get(p.id)).toBeUndefined();
    expect(registry.unregister(p.id)).toBe(false); // already gone
  });

  it('different absolute paths produce different ids', () => {
    const a = path.join(tmpDir, 'a'); fs.mkdirSync(a);
    const b = path.join(tmpDir, 'b'); fs.mkdirSync(b);
    expect(deriveProjectId(a)).not.toBe(deriveProjectId(b));
  });

  it('projectPaths derives a stable per-project layout under dataRoot', () => {
    const p = registry.register(tmpDir);
    const paths = projectPaths(p, '/data');
    expect(paths.base).toBe(path.join('/data', 'projects', p.id));
    expect(paths.memoryDb).toBe(path.join(paths.base, 'memory.db'));
    expect(paths.vectorsDir).toBe(path.join(paths.base, 'vectors'));
    expect(paths.graphsDir).toBe(path.join(paths.base, 'graphs'));
    expect(paths.backupsDir).toBe(path.join(paths.base, 'backups'));
  });
});
