import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { readProjectConventions } from '../project-conventions.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-test-'));
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function write(file: string, content = ''): void {
  const full = path.join(tmpRoot, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('detectTestFileExtension (v1.51)', () => {
  it('detects .test.ts when project uses it', () => {
    write('package.json', '{}');
    write('src/foo.test.ts');
    write('src/bar.test.ts');
    write('src/baz.test.ts');
    const c = readProjectConventions(tmpRoot);
    expect(c.testFileExtension).toBe('.test.ts');
    expect(c.summary).toContain('.test.ts');
  });

  it('detects .spec.ts when more frequent than .test.ts', () => {
    write('package.json', '{}');
    write('src/a.test.ts');
    write('src/b.spec.ts');
    write('src/c.spec.ts');
    write('src/d.spec.ts');
    const c = readProjectConventions(tmpRoot);
    expect(c.testFileExtension).toBe('.spec.ts');
  });

  it('falls back to .test.ts when no test files found', () => {
    write('package.json', '{}');
    write('src/main.ts');
    const c = readProjectConventions(tmpRoot);
    expect(c.testFileExtension).toBe('.test.ts');
  });

  it('searches packages/ subdirectories (monorepo support)', () => {
    write('package.json', '{}');
    write('packages/server/src/x.test.js');
    write('packages/server/src/y.test.js');
    const c = readProjectConventions(tmpRoot);
    expect(c.testFileExtension).toBe('.test.js');
  });

  it('skips node_modules and dist when scanning', () => {
    write('package.json', '{}');
    write('src/a.test.ts');
    write('node_modules/some-pkg/x.spec.js');
    write('node_modules/some-pkg/y.spec.js');
    write('node_modules/some-pkg/z.spec.js');
    write('dist/old.test.js');
    const c = readProjectConventions(tmpRoot);
    // .test.ts (1 src file) wins over .spec.js (3 in node_modules ignored)
    expect(c.testFileExtension).toBe('.test.ts');
  });
});
