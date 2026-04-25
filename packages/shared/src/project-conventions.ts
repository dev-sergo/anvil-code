import fs from 'fs';
import path from 'path';

export interface ProjectConventions {
  testFramework: 'vitest' | 'jest' | 'mocha' | 'tap' | 'none';
  moduleType: 'esm' | 'commonjs';
  tsStrict: boolean;
  moduleResolution: 'node' | 'nodenext' | 'node16' | 'bundler' | 'classic' | 'unknown';
  needsJsSuffix: boolean;
  runtimeFrameworks: string[];
  entryPoints: string[];
  summary: string;
}

interface PackageJson {
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface TsConfigJson {
  compilerOptions?: {
    strict?: boolean;
    moduleResolution?: string;
  };
}

const KNOWN_FRAMEWORKS = ['fastify', 'express', 'koa', 'hapi', 'nest', 'hono', 'elysia'];
const KNOWN_ENTRY_POINTS = ['server.ts', 'main.ts', 'app.ts', 'index.ts', 'server.js', 'main.js', 'app.js', 'index.js'];

export function readProjectConventions(projectRoot: string): ProjectConventions {
  const pkg = readJsonSafe<PackageJson>(path.join(projectRoot, 'package.json')) ?? {};
  const tsconfig = readJsonSafe<TsConfigJson>(path.join(projectRoot, 'tsconfig.json'));

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const testFramework = detectTestFramework(allDeps);
  const moduleType = pkg.type === 'module' ? 'esm' : 'commonjs';

  const tsStrict = tsconfig?.compilerOptions?.strict === true;
  const moduleResolution = normalizeModuleResolution(tsconfig?.compilerOptions?.moduleResolution);
  const needsJsSuffix = moduleType === 'esm' && (moduleResolution === 'nodenext' || moduleResolution === 'node16');

  const runtimeFrameworks = KNOWN_FRAMEWORKS.filter(f => f in allDeps);
  const entryPoints = findEntryPoints(projectRoot);

  const summary = buildSummary({
    testFramework,
    moduleType,
    tsStrict,
    moduleResolution,
    needsJsSuffix,
    runtimeFrameworks,
    entryPoints,
  });

  return {
    testFramework,
    moduleType,
    tsStrict,
    moduleResolution,
    needsJsSuffix,
    runtimeFrameworks,
    entryPoints,
    summary,
  };
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(stripJsonComments(raw)) as T;
  } catch {
    return null;
  }
}

// tsconfig.json allows // and /* */ comments. JSON.parse doesn't.
function stripJsonComments(raw: string): string {
  return raw
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function detectTestFramework(deps: Record<string, string>): ProjectConventions['testFramework'] {
  if ('vitest' in deps) return 'vitest';
  if ('jest' in deps) return 'jest';
  if ('mocha' in deps) return 'mocha';
  if ('tap' in deps) return 'tap';
  return 'none';
}

function normalizeModuleResolution(raw: string | undefined): ProjectConventions['moduleResolution'] {
  if (!raw) return 'unknown';
  const v = raw.toLowerCase();
  if (v === 'nodenext' || v === 'node16' || v === 'node' || v === 'bundler' || v === 'classic') return v;
  return 'unknown';
}

function findEntryPoints(root: string): string[] {
  const srcRoot = path.join(root, 'src');
  const candidates = KNOWN_ENTRY_POINTS.flatMap(name => [
    path.join(srcRoot, name),
    path.join(root, name),
  ]);
  return candidates
    .filter(p => {
      try { return fs.statSync(p).isFile(); } catch { return false; }
    })
    .map(p => path.relative(root, p));
}

function buildSummary(c: Omit<ProjectConventions, 'summary'>): string {
  const lines: string[] = [];
  lines.push(`- Test framework: ${c.testFramework}` + (c.testFramework === 'vitest' ? ' (import { describe, it, expect } from \'vitest\')' : ''));
  lines.push(`- Module system: ${c.moduleType.toUpperCase()}`);
  if (c.needsJsSuffix) {
    lines.push('- Import paths MUST include .js suffix (TypeScript with NodeNext moduleResolution)');
  }
  if (c.tsStrict) {
    lines.push('- TypeScript strict mode: enabled (no implicit any, null checks, etc.)');
  }
  if (c.runtimeFrameworks.length > 0) {
    lines.push(`- Runtime framework(s): ${c.runtimeFrameworks.join(', ')}`);
  }
  if (c.entryPoints.length > 0) {
    lines.push(`- Existing entry point(s): ${c.entryPoints.join(', ')} — modify these, do not create parallel bootstrap files`);
  }
  if (lines.length === 0) return '(no conventions detected)';
  return lines.join('\n');
}
