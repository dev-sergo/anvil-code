import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';

// Provide a minimal config stub so SafeWriter doesn't need the full shared package at test time
vi.mock('@rag-system/shared', () => ({
  config: {
    projectRoot: os.tmpdir(),
    safeExec: { dryRun: false, backup: false, backupsPath: os.tmpdir() },
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Stub BackupManager and DiffEngine to isolate SafeWriter logic
vi.mock('../backup.js', () => ({ BackupManager: class { backup() {} } }));
vi.mock('../diff-engine.js', () => ({ DiffEngine: class { generate() { return { diff: '' }; } } }));

const { SafeWriter } = await import('../writer.js');

describe('SafeWriter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-writer-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Path traversal protection ──────────────────────────────────────────────

  it('blocks path traversal with ../', () => {
    const writer = new SafeWriter(tmpDir);
    expect(() =>
      writer.execute({ path: '../../etc/passwd', content: '', action: 'create' })
    ).toThrow('Path traversal attempt blocked');
  });

  it('blocks absolute path outside project root', () => {
    const writer = new SafeWriter(tmpDir);
    expect(() =>
      writer.execute({ path: '/etc/passwd', content: '', action: 'create' })
    ).toThrow('Path traversal attempt blocked');
  });

  it('blocks path traversal with encoded segments', () => {
    const writer = new SafeWriter(tmpDir);
    expect(() =>
      writer.execute({ path: 'foo/../../etc/passwd', content: '', action: 'create' })
    ).toThrow('Path traversal attempt blocked');
  });

  // ── Valid operations ───────────────────────────────────────────────────────

  it('creates a file inside project root', () => {
    const writer = new SafeWriter(tmpDir);
    writer.execute({ path: 'src/foo.ts', content: 'export {}', action: 'create' });
    expect(fs.readFileSync(path.join(tmpDir, 'src/foo.ts'), 'utf8')).toBe('export {}');
  });

  it('creates nested directories as needed', () => {
    const writer = new SafeWriter(tmpDir);
    writer.execute({ path: 'a/b/c/file.ts', content: '// hi', action: 'create' });
    expect(fs.existsSync(path.join(tmpDir, 'a/b/c/file.ts'))).toBe(true);
  });

  it('modifies an existing file', () => {
    const filePath = path.join(tmpDir, 'existing.ts');
    fs.writeFileSync(filePath, 'old content');
    const writer = new SafeWriter(tmpDir);
    writer.execute({ path: 'existing.ts', content: 'new content', action: 'modify' });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('new content');
  });

  it('deletes a file', () => {
    const filePath = path.join(tmpDir, 'to-delete.ts');
    fs.writeFileSync(filePath, 'content');
    const writer = new SafeWriter(tmpDir);
    writer.execute({ path: 'to-delete.ts', content: '', action: 'delete' });
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
