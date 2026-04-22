import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';

vi.mock('@rag-system/shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { TestRunner } = await import('../test-runner.js');

describe('TestRunner', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-runner-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips when no package.json exists', async () => {
    const runner = new TestRunner(tmpDir);
    const result = await runner.run();
    expect(result.success).toBe(true);
    expect(result.skipped).toBe('no package.json');
  });

  it('skips when no test script defined', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test' }));
    const runner = new TestRunner(tmpDir);
    const result = await runner.run();
    expect(result.success).toBe(true);
    expect(result.skipped).toBe('no test script defined');
  });

  it('skips when test script is the npm default placeholder', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    );
    const runner = new TestRunner(tmpDir);
    const result = await runner.run();
    expect(result.success).toBe(true);
    expect(result.skipped).toBe('no test script defined');
  });

  it('skips invalid package.json gracefully', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), 'not json {');
    const runner = new TestRunner(tmpDir);
    const result = await runner.run();
    expect(result.success).toBe(true);
    expect(result.skipped).toBe('invalid package.json');
  });
});
