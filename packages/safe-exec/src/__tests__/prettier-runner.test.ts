import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';

vi.mock('@rag-system/shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { PrettierRunner, isPrettierConfigured } = await import('../prettier-runner.js');

describe('isPrettierConfigured — detection signals', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prettier-detect-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns false on an empty project', () => {
    expect(isPrettierConfigured(tmpDir)).toBe(false);
  });

  it('detects .prettierrc.json', () => {
    fs.writeFileSync(path.join(tmpDir, '.prettierrc.json'), '{"singleQuote":true}');
    expect(isPrettierConfigured(tmpDir)).toBe(true);
  });

  it('detects bare .prettierrc (no extension)', () => {
    fs.writeFileSync(path.join(tmpDir, '.prettierrc'), '{}');
    expect(isPrettierConfigured(tmpDir)).toBe(true);
  });

  it('detects prettier.config.cjs', () => {
    fs.writeFileSync(path.join(tmpDir, 'prettier.config.cjs'), 'module.exports = {};');
    expect(isPrettierConfigured(tmpDir)).toBe(true);
  });

  it('detects "prettier" field in package.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ prettier: { singleQuote: true } }));
    expect(isPrettierConfigured(tmpDir)).toBe(true);
  });

  it('detects prettier in devDependencies', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ devDependencies: { prettier: '^3.0.0' } }),
    );
    expect(isPrettierConfigured(tmpDir)).toBe(true);
  });

  it('detects prettier in dependencies', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { prettier: '^3.0.0' } }),
    );
    expect(isPrettierConfigured(tmpDir)).toBe(true);
  });

  it('returns false for invalid package.json without throwing', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), 'not json {');
    expect(isPrettierConfigured(tmpDir)).toBe(false);
  });
});

describe('PrettierRunner.run — skip paths', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prettier-skip-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('skips when no files passed', async () => {
    const r = await new PrettierRunner(tmpDir).run([]);
    expect(r.success).toBe(true);
    expect(r.skipped).toBe('no files');
    expect(r.formatted).toEqual([]);
  });

  it('skips when prettier is not configured', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const x = 1;');
    const r = await new PrettierRunner(tmpDir).run(['a.ts']);
    expect(r.success).toBe(true);
    expect(r.skipped).toBe('no prettier config');
  });

  it('skips when configured but no formattable files in list', async () => {
    fs.writeFileSync(path.join(tmpDir, '.prettierrc.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'image.png'), '');
    const r = await new PrettierRunner(tmpDir).run(['image.png']);
    expect(r.success).toBe(true);
    expect(r.skipped).toBe('no formattable files');
  });

  it('skips when configured but local prettier binary missing', async () => {
    fs.writeFileSync(path.join(tmpDir, '.prettierrc.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const x = 1;');
    // No node_modules/.bin/prettier in tmpDir
    const r = await new PrettierRunner(tmpDir).run(['a.ts']);
    expect(r.success).toBe(true);
    expect(r.skipped).toBe('prettier not installed in target project');
  });

  it('filters out files that do not exist on disk', async () => {
    fs.writeFileSync(path.join(tmpDir, '.prettierrc.json'), '{}');
    // No a.ts file written, so candidate filtering drops it
    const r = await new PrettierRunner(tmpDir).run(['a.ts', 'b.ts']);
    expect(r.success).toBe(true);
    expect(r.skipped).toBe('no formattable files');
  });
});

describe('PrettierRunner.run — actual format invocation', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prettier-run-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  /**
   * Build a fake prettier binary that records its invocation arguments to a
   * file and exits 0. Lets us assert PrettierRunner spawned it correctly
   * without depending on a real prettier install.
   */
  function fakePrettier(tmpDir: string, exitCode: number): string {
    const binDir = path.join(tmpDir, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, 'prettier');
    const argLog = path.join(tmpDir, 'prettier-args.log');
    fs.writeFileSync(
      binPath,
      `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(argLog)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(${exitCode});\n`,
    );
    fs.chmodSync(binPath, 0o755);
    return argLog;
  }

  it('runs prettier --write on formattable files when configured', async () => {
    fs.writeFileSync(path.join(tmpDir, '.prettierrc.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const x = 1;');
    fs.writeFileSync(path.join(tmpDir, 'b.tsx'), 'const y = 2;');
    fs.writeFileSync(path.join(tmpDir, 'data.bin'), 'opaque'); // filtered out
    const argLog = fakePrettier(tmpDir, 0);

    const r = await new PrettierRunner(tmpDir).run(['a.ts', 'b.tsx', 'data.bin']);
    expect(r.success).toBe(true);
    expect(r.formatted).toEqual(['a.ts', 'b.tsx']);

    const args = JSON.parse(fs.readFileSync(argLog, 'utf8')) as string[];
    expect(args[0]).toBe('--write');
    expect(args).toContain('a.ts');
    expect(args).toContain('b.tsx');
    expect(args).not.toContain('data.bin');
  });

  it('returns success=false (but does not throw) when prettier exits non-zero', async () => {
    fs.writeFileSync(path.join(tmpDir, '.prettierrc.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'broken.ts'), 'const x = ');
    fakePrettier(tmpDir, 2);

    const r = await new PrettierRunner(tmpDir).run(['broken.ts']);
    expect(r.success).toBe(false);
    expect(r.formatted).toEqual([]);
    // Caller MUST not treat this as a commit-blocker — that contract is
    // documented on PrettierResult.success and exercised in orchestrator wiring.
  });
});
