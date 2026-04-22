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

const { BackupManager } = await import('../backup.js');

describe('BackupManager.prune', () => {
  let tmpDir: string;
  let backupsDir: string;
  let now: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-prune-'));
    backupsDir = path.join(tmpDir, 'backups');
    fs.mkdirSync(backupsDir);
    now = Date.now();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeBackup(timestamp: number, ext = '.ts'): string {
    const name = `abcd1234-${timestamp}${ext}`;
    const p = path.join(backupsDir, name);
    fs.writeFileSync(p, 'data');
    return p;
  }

  it('deletes files older than maxAgeMs and keeps newer ones', () => {
    const old1 = writeBackup(now - 10 * 24 * 3600 * 1000); // 10 days old
    const old2 = writeBackup(now - 8 * 24 * 3600 * 1000, '.py');  // 8 days old
    const fresh = writeBackup(now - 1 * 24 * 3600 * 1000); // 1 day

    const mgr = new BackupManager(backupsDir);
    const removed = mgr.prune(7 * 24 * 3600 * 1000, now);

    expect(removed).toBe(2);
    expect(fs.existsSync(old1)).toBe(false);
    expect(fs.existsSync(old2)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('skips entries that do not match the backup naming pattern', () => {
    fs.writeFileSync(path.join(backupsDir, 'README.md'), '# notes');
    fs.writeFileSync(path.join(backupsDir, 'random.log'), 'x');
    const fresh = writeBackup(now - 1000);

    const mgr = new BackupManager(backupsDir);
    const removed = mgr.prune(1, now); // every backup file is "old", but non-matching are kept

    expect(removed).toBe(1);
    expect(fs.existsSync(fresh)).toBe(false);
    expect(fs.existsSync(path.join(backupsDir, 'README.md'))).toBe(true);
  });

  it('returns 0 when backupsDir does not exist', () => {
    const mgr = new BackupManager(path.join(tmpDir, 'missing'));
    expect(mgr.prune()).toBe(0);
  });

  it('returns 0 when no files are old enough', () => {
    writeBackup(now - 1000);
    const mgr = new BackupManager(backupsDir);
    expect(mgr.prune(7 * 24 * 3600 * 1000, now)).toBe(0);
  });
});
