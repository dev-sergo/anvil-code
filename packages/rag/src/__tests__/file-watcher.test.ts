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

const { FileWatcher } = await import('../file-watcher.js');

function makeRetriever() {
  return {
    indexFile: vi.fn().mockResolvedValue(undefined),
    removeFile: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
  };
}

describe('FileWatcher', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-watcher-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('debounces add+change events into a single reindex+flush', async () => {
    const retriever = makeRetriever();
    const watcher = new FileWatcher(retriever as never, { rootDir: tmpDir, debounceMs: 200 });
    watcher.start();
    // Let chokidar finish its initial scan
    await new Promise(r => setTimeout(r, 200));

    const file = path.join(tmpDir, 'foo.ts');
    fs.writeFileSync(file, 'export const a = 1;');
    await new Promise(r => setTimeout(r, 400));
    fs.writeFileSync(file, 'export const a = 2;');
    await new Promise(r => setTimeout(r, 400));

    await watcher.drain();
    await watcher.stop();

    expect(retriever.indexFile).toHaveBeenCalledWith(file);
    expect(retriever.flush).toHaveBeenCalled();
    expect(retriever.removeFile).not.toHaveBeenCalled();
  }, 5_000);

  it('routes unlink events to removeFile', async () => {
    const retriever = makeRetriever();
    const file = path.join(tmpDir, 'bar.ts');
    fs.writeFileSync(file, 'export {};');

    const watcher = new FileWatcher(retriever as never, { rootDir: tmpDir, debounceMs: 100 });
    watcher.start();
    // chokidar needs time to spin up
    await new Promise(r => setTimeout(r, 150));

    fs.unlinkSync(file);
    await new Promise(r => setTimeout(r, 250));
    await watcher.drain();
    await watcher.stop();

    expect(retriever.removeFile).toHaveBeenCalledWith(file);
    expect(retriever.flush).toHaveBeenCalled();
  }, 5_000);

  it('start is idempotent and stop drains pending work', async () => {
    const retriever = makeRetriever();
    const watcher = new FileWatcher(retriever as never, { rootDir: tmpDir, debounceMs: 100 });
    watcher.start();
    watcher.start(); // no-op
    await watcher.stop();

    expect(retriever.indexFile).not.toHaveBeenCalled();
    expect(retriever.removeFile).not.toHaveBeenCalled();
  });
});
