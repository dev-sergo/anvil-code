import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';

vi.mock('@rag-system/shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { TypeChecker } = await import('../type-checker.js');

describe('TypeChecker', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'type-checker-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips when no tsconfig.json or tsconfig.base.json exists', async () => {
    const checker = new TypeChecker(tmpDir);
    const result = await checker.run();
    expect(result.success).toBe(true);
    expect(result.skipped).toBe('no tsconfig.json');
  });

  it('finds tsconfig.json when present', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { noEmit: true } }),
    );
    // Project doesn't include any TS files but tsconfig is present, so it shouldn't skip
    const checker = new TypeChecker(tmpDir, 5_000);
    const result = await checker.run();
    expect(result.skipped).toBeUndefined();
  });
});
