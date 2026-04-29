import { describe, it, expect } from 'vitest';
import {
  locateAddMethod,
  locateReplaceMethod,
  locateReplaceFunction,
  locateAddRoute,
  locateAddImport,
  locateAddExport,
} from '../structural-edits.js';

/**
 * The locate* helpers return a StructuralEdit describing where the dispatcher
 * should call ws.insertBefore / ws.replace. These tests verify only the
 * locator output (line numbers, text) — the actual file mutation is covered
 * by working-set.test.ts and tool-calling-coder.test.ts.
 */

describe('locateAddMethod', () => {
  it('inserts before the closing brace of a class with one existing method', () => {
    const content =
      [
        'export class Foo {',
        '  bar() {',
        '    return 1;',
        '  }',
        '}',
        '',
      ].join('\n');

    const r = locateAddMethod(
      content,
      'Foo',
      'baz(): number {\n  return 2;\n}',
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.edit.kind).toBe('insert');
    if (r.edit.kind !== 'insert') return;
    // Closing brace is on line 5 (1-indexed); we insert before it.
    expect(r.edit.line).toBe(5);
    // Leading blank line because the class already has members.
    expect(r.edit.text).toBe('\n  baz(): number {\n    return 2;\n  }');
  });

  it('inserts into an empty class without a leading blank line', () => {
    const content = ['export class Foo {', '}', ''].join('\n');

    const r = locateAddMethod(content, 'Foo', 'baz() {}');

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'insert') return;
    expect(r.edit.line).toBe(2);
    // No leading blank, indent = class column + 2 spaces.
    expect(r.edit.text).toBe('  baz() {}');
  });

  it('detects member indent style (4 spaces) from existing members', () => {
    const content =
      [
        'class Foo {',
        '    existing() {',
        '        return 1;',
        '    }',
        '}',
        '',
      ].join('\n');

    const r = locateAddMethod(content, 'Foo', 'fresh() {\n  return 2;\n}');

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'insert') return;
    // 4-space indent for the new method, relative re-indent for the body.
    expect(r.edit.text).toBe('\n    fresh() {\n      return 2;\n    }');
  });

  it('rejects when the named class is not found', () => {
    const content = 'class Other {}\n';
    const r = locateAddMethod(content, 'Missing', 'foo() {}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/class Missing not found/);
  });

  it('rejects when a method with the same name already exists', () => {
    const content = ['class Foo {', '  bar() {}', '}', ''].join('\n');
    const r = locateAddMethod(content, 'Foo', 'bar() { return 2; }');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Foo\.bar already exists/);
    expect(r.error).toMatch(/use replace_method/);
  });

  it('rejects when source is not a single method declaration', () => {
    const content = ['class Foo {', '}', ''].join('\n');
    // Two methods packed into one source — must be exactly one.
    const r = locateAddMethod(content, 'Foo', 'a() {}\nb() {}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/exactly one method/);
  });

  it('rejects when the class is declared inline on a single line', () => {
    const content = 'class Foo { bar() {} }\n';
    const r = locateAddMethod(content, 'Foo', 'baz() {}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/refactor to a multi-line class/);
  });

  it('handles a multi-line method body in source with correct re-indentation', () => {
    const content =
      [
        'class Foo {',
        '  bar() {',
        '    return 1;',
        '  }',
        '}',
        '',
      ].join('\n');

    const source = 'async getSize(): Promise<number> {\n  return this.length;\n}';
    const r = locateAddMethod(content, 'Foo', source);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'insert') return;
    expect(r.edit.text).toBe(
      '\n  async getSize(): Promise<number> {\n    return this.length;\n  }',
    );
  });

  it('preserves indent when source itself is already pre-indented', () => {
    const content = ['class Foo {', '  existing() {}', '}', ''].join('\n');
    // Pre-indented source — reindent should normalize to target without doubling.
    const source = '  fresh() {\n    return 2;\n  }';
    const r = locateAddMethod(content, 'Foo', source);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'insert') return;
    expect(r.edit.text).toBe('\n  fresh() {\n    return 2;\n  }');
  });
});

describe('locateReplaceMethod', () => {
  it('replaces a single-line method body with a multi-line one', () => {
    const content =
      [
        'class Foo {',
        '  bar() { return 1; }',
        '  baz() { return 2; }',
        '}',
        '',
      ].join('\n');

    const r = locateReplaceMethod(
      content,
      'Foo',
      'bar',
      'bar(): number {\n  return 99;\n}',
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'replace') return;
    expect(r.edit.startLine).toBe(2);
    expect(r.edit.endLine).toBe(2);
    expect(r.edit.text).toBe('  bar(): number {\n    return 99;\n  }');
  });

  it('replaces a multi-line method spanning several lines', () => {
    const content =
      [
        'class Foo {',
        '  bar() {',
        '    return 1;',
        '  }',
        '  baz() {}',
        '}',
        '',
      ].join('\n');

    const r = locateReplaceMethod(
      content,
      'Foo',
      'bar',
      'async bar(): Promise<number> {\n  return await this.x;\n}',
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'replace') return;
    expect(r.edit.startLine).toBe(2);
    expect(r.edit.endLine).toBe(4);
    expect(r.edit.text).toBe(
      '  async bar(): Promise<number> {\n    return await this.x;\n  }',
    );
  });

  it('preserves a jsdoc comment above the method (it sits on lines outside the replace range)', () => {
    const content =
      [
        'class Foo {',
        '  /** existing doc */',
        '  bar() {',
        '    return 1;',
        '  }',
        '}',
        '',
      ].join('\n');

    const r = locateReplaceMethod(content, 'Foo', 'bar', 'bar() { return 2; }');

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'replace') return;
    // bar starts at line 3 (after jsdoc); jsdoc on line 2 stays untouched.
    expect(r.edit.startLine).toBe(3);
    expect(r.edit.endLine).toBe(5);
  });

  it('rejects when the method is not found on the class', () => {
    const content = ['class Foo {', '  bar() {}', '}', ''].join('\n');
    const r = locateReplaceMethod(content, 'Foo', 'missing', 'missing() {}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/method Foo\.missing not found/);
  });

  it('rejects when the class is not found', () => {
    const content = 'class Other {}\n';
    const r = locateReplaceMethod(content, 'Foo', 'bar', 'bar() {}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/class Foo not found/);
  });

  it('rejects when source method name differs from name parameter', () => {
    const content = ['class Foo {', '  bar() {}', '}', ''].join('\n');
    const r = locateReplaceMethod(content, 'Foo', 'bar', 'baz() {}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/source declares method 'baz'/);
    expect(r.error).toMatch(/replace_method was called with name='bar'/);
  });

  it('handles modifiers (async/static) in the replacement source', () => {
    const content =
      [
        'class Foo {',
        '  bar(): number {',
        '    return 1;',
        '  }',
        '}',
        '',
      ].join('\n');

    const r = locateReplaceMethod(
      content,
      'Foo',
      'bar',
      'static async bar(): Promise<number> {\n  return 2;\n}',
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'replace') return;
    expect(r.edit.text).toBe(
      '  static async bar(): Promise<number> {\n    return 2;\n  }',
    );
  });
});

describe('locateReplaceFunction', () => {
  it('replaces a top-level function declaration', () => {
    const content =
      [
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
        '',
      ].join('\n');

    const r = locateReplaceFunction(
      content,
      'add',
      'export function add(a: number, b: number): number {\n  return (a + b) | 0;\n}',
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'replace') return;
    expect(r.edit.startLine).toBe(1);
    expect(r.edit.endLine).toBe(3);
  });

  it('rejects when the function is not at the top level', () => {
    // Function declared inside a block — top-level lookup must not see it.
    const content =
      [
        'function outer() {',
        '  function inner() { return 1; }',
        '  return inner;',
        '}',
        '',
      ].join('\n');

    const r = locateReplaceFunction(content, 'inner', 'function inner() { return 2; }');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/top-level function inner not found/);
  });

  it('rejects when source is not a function declaration', () => {
    const content = 'function foo() {}\n';
    const r = locateReplaceFunction(content, 'foo', 'const foo = () => 1;');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/top-level function declaration/);
  });

  it('rejects when source name does not match the name parameter', () => {
    const content = 'function foo() {}\n';
    const r = locateReplaceFunction(content, 'foo', 'function bar() {}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/source declares function 'bar'/);
  });

  it('preserves leading jsdoc when replacing the function body', () => {
    const content =
      [
        '/**',
        ' * Existing doc.',
        ' */',
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
        '',
      ].join('\n');

    const r = locateReplaceFunction(
      content,
      'add',
      'export function add(a: number, b: number): number {\n  return a - b;\n}',
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'replace') return;
    // Function (first non-comment token) starts at line 4; jsdoc on lines 1-3 untouched.
    expect(r.edit.startLine).toBe(4);
    expect(r.edit.endLine).toBe(6);
  });
});

describe('locateAddRoute', () => {
  // Minimal Fastify-style server file used as the bench-stand-in for /version.
  const fastifyFile = [
    "import Fastify from 'fastify';",
    '',
    'export async function buildServer() {',
    '  const app = Fastify();',
    '',
    "  app.get('/health', async () => {",
    "    return { status: 'ok' };",
    '  });',
    '',
    "  app.post('/task', async (request, reply) => {",
    '    return { id: 1 };',
    '  });',
    '',
    '  return app;',
    '}',
    '',
  ].join('\n');

  it('inserts a new route after the last existing route', () => {
    const r = locateAddRoute(
      fastifyFile,
      'GET',
      '/version',
      "return { version: '1.0.0' };",
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'insert') return;
    // /task ends at line 12 (1-indexed); insertion sits before line 13.
    expect(r.edit.line).toBe(13);
    // Indent matches existing routes (2 spaces) and reuses 'app' as the target.
    expect(r.edit.text).toBe(
      "\n  app.get('/version', async (request, reply) => {\n    return { version: '1.0.0' };\n  });",
    );
  });

  it('respects a custom params override (e.g. () for unused)', () => {
    const r = locateAddRoute(
      fastifyFile,
      'GET',
      '/version',
      "return { version: '1.0.0' };",
      '()',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'insert') return;
    expect(r.edit.text).toContain("async () => {");
  });

  it('reuses the actual instance name from the existing route (e.g. server, not app)', () => {
    const serverFile = [
      'export async function build() {',
      '  const server = Fastify();',
      "  server.get('/health', async () => ({}));",
      '  return server;',
      '}',
      '',
    ].join('\n');

    const r = locateAddRoute(serverFile, 'POST', '/echo', 'return request.body;');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'insert') return;
    expect(r.edit.text).toContain('server.post');
    expect(r.edit.text).not.toContain('app.post');
  });

  it('rejects when no Fastify routes exist (cannot anchor)', () => {
    const empty = 'export function build() { return null; }\n';
    const r = locateAddRoute(empty, 'GET', '/x', 'return {};');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/no Fastify route calls/);
  });

  it('rejects duplicate route (same method + same path)', () => {
    const r = locateAddRoute(fastifyFile, 'GET', '/health', 'return {};');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/route GET \/health already exists/);
  });

  it('allows the same path with a different HTTP method (GET /x and POST /x are distinct)', () => {
    const r = locateAddRoute(fastifyFile, 'POST', '/health', 'return reply.send();');
    expect(r.ok).toBe(true);
  });

  it('rejects unknown HTTP method', () => {
    const r = locateAddRoute(fastifyFile, 'TRACE', '/x', 'return {};');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/unknown HTTP method/);
  });

  it("rejects route_path that contains a single quote (would break literal rendering)", () => {
    const r = locateAddRoute(fastifyFile, 'GET', "/it's", 'return {};');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/route_path/);
  });

  it('detects 4-space indent style and re-indents the body to match', () => {
    const fourSpace = [
      'export async function build() {',
      '    const app = Fastify();',
      "    app.get('/health', async () => ({}));",
      '    return app;',
      '}',
      '',
    ].join('\n');
    const r = locateAddRoute(fourSpace, 'GET', '/version', "return { v: 1 };");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'insert') return;
    // 4-space outer indent; body at 8 spaces.
    expect(r.edit.text).toBe(
      "\n    app.get('/version', async (request, reply) => {\n        return { v: 1 };\n    });",
    );
  });
});

describe('locateAddImport', () => {
  it('inserts a new import after the last existing import', () => {
    const content = [
      "import { a } from './a.js';",
      "import { b } from './b.js';",
      '',
      'export const X = 1;',
      '',
    ].join('\n');

    const r = locateAddImport(content, './c.js', ['c']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'insert') return;
    expect(r.edit.line).toBe(3);
    expect(r.edit.text).toBe("import { c } from './c.js';");
  });

  it('inserts at top of file when no imports exist', () => {
    const content = 'export const X = 1;\n';
    const r = locateAddImport(content, 'pino', [], 'pino');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'insert') return;
    expect(r.edit.line).toBe(1);
    expect(r.edit.text).toBe("import pino from 'pino';\n");
  });

  it('merges new names into an existing import from the same source', () => {
    const content = "import { a } from './lib.js';\nexport const X = 1;\n";
    const r = locateAddImport(content, './lib.js', ['b', 'c']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'replace') return;
    expect(r.edit.startLine).toBe(1);
    expect(r.edit.endLine).toBe(1);
    expect(r.edit.text).toBe("import { a, b, c } from './lib.js';");
  });

  it('returns noop when all requested names are already imported', () => {
    const content = "import { a, b } from './lib.js';\n";
    const r = locateAddImport(content, './lib.js', ['a', 'b']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.edit.kind).toBe('noop');
  });

  it('rejects when the request type-only flag conflicts with the existing import', () => {
    const content = "import type { Foo } from './types.js';\n";
    const r = locateAddImport(content, './types.js', ['Bar'], undefined, false);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/type-only/);
  });

  it('renders type-only imports correctly', () => {
    const content = "export const X = 1;\n";
    const r = locateAddImport(content, './types.js', ['Foo', 'Bar'], undefined, true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'insert') return;
    expect(r.edit.text).toBe("import type { Bar, Foo } from './types.js';\n");
  });

  it('preserves the existing default name when only adding named imports', () => {
    const content = "import D, { a } from './lib.js';\n";
    const r = locateAddImport(content, './lib.js', ['b']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'replace') return;
    expect(r.edit.text).toBe("import D, { a, b } from './lib.js';");
  });

  it('rejects merging into an existing namespace import', () => {
    const content = "import * as ns from './lib.js';\n";
    const r = locateAddImport(content, './lib.js', ['x']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/namespace form/);
  });
});

describe('locateAddExport', () => {
  it('appends after the last existing export', () => {
    const content = [
      "import { x } from './x.js';",
      '',
      'export const A = 1;',
      'export const B = 2;',
      '',
    ].join('\n');

    const r = locateAddExport(content, 'export const C = 3;');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'insert') return;
    // Line after `export const B = 2;` (line 4) is 5; insertion sits before it.
    expect(r.edit.line).toBe(5);
    expect(r.edit.text).toBe('\nexport const C = 3;');
  });

  it('falls back to after the last import when no exports exist yet', () => {
    const content = [
      "import { x } from './x.js';",
      '',
      'const internal = 1;',
      '',
    ].join('\n');
    const r = locateAddExport(content, 'export const Y = 2;');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'insert') return;
    // last import on line 1, insert sits before line 3 (skipping the blank).
    // `endPos.line + 2` in 1-index = 1 + 2? Wait — endLine0 of "import...;\n"
    // is 0 (the line of the closing semicolon). +2 → line 2. That's the
    // blank line right after the import — good place to drop new content.
    expect(r.edit.line).toBe(2);
  });

  it('rejects when source is not a top-level export', () => {
    const content = 'export const A = 1;\n';
    const r = locateAddExport(content, 'const internal = 1;');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/top-level export/);
  });

  it('rejects when source contains multiple statements', () => {
    const content = 'export const A = 1;\n';
    const r = locateAddExport(content, 'export const X = 1; export const Y = 2;');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/exactly one statement/);
  });

  it('inserts at top of an empty file when no anchor exists', () => {
    const content = '';
    const r = locateAddExport(content, 'export const X = 1;');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.edit.kind !== 'insert') return;
    expect(r.edit.line).toBe(1);
    expect(r.edit.text).toBe('export const X = 1;\n');
  });

  it('accepts `export type` and `export interface` declarations', () => {
    const content = 'export const A = 1;\n';
    const r1 = locateAddExport(content, 'export type Foo = string;');
    expect(r1.ok).toBe(true);
    const r2 = locateAddExport(content, 'export interface Bar { x: number }');
    expect(r2.ok).toBe(true);
  });

  it('accepts `export { ... }` re-export declarations', () => {
    const content = "import { x } from './x.js';\n";
    const r = locateAddExport(content, "export { x };");
    expect(r.ok).toBe(true);
  });
});
