import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import {
  dispatchToolCall,
  TOOL_DEFINITIONS,
  extractAllowedPaths,
  isWriteAllowed,
  checkBraceBalance,
} from '../tool-calling-coder.js';
import type { WritePolicy } from '../tool-calling-coder.js';
import { WorkingSet } from '../working-set.js';

describe('TOOL_DEFINITIONS', () => {
  it('exposes the line-coordinate tools (4) + structural tools (6) + done', () => {
    const names = TOOL_DEFINITIONS.map(t => t.function.name);
    expect(names).toEqual([
      // Line-coordinate / fallback tools
      'read_file',
      'replace_in_file',
      'create_file',
      'delete_file',
      // v1.31 structural tools
      'add_method',
      'replace_method',
      'replace_function',
      'add_route',
      'add_import',
      'add_export',
      // Loop terminator
      'done',
    ]);
  });

  it('every tool has a non-empty description and parameters object', () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(t.function.description.length).toBeGreaterThan(0);
      expect(t.function.parameters.type).toBe('object');
      // done() is the only tool with no required args
      if (t.function.name === 'done') {
        expect(t.function.parameters.required ?? []).toEqual([]);
      } else {
        expect((t.function.parameters.required ?? []).length).toBeGreaterThan(0);
      }
    }
  });
});

describe('dispatchToolCall', () => {
  let tmpDir: string;
  let ws: WorkingSet;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-dispatch-'));
    ws = new WorkingSet(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  it('read_file returns line-numbered content with header', () => {
    write('src/a.ts', 'first\nsecond\nthird\n');
    const r = dispatchToolCall(
      { function: { name: 'read_file', arguments: { path: 'src/a.ts' } } },
      ws,
    );
    expect(r.done).toBe(false);
    expect(r.text).toContain('# src/a.ts');
    expect(r.text).toContain('   1 | first');
    expect(r.text).toContain('   2 | second');
    expect(r.text).toContain('   3 | third');
  });

  it('read_file returns error for missing file', () => {
    const r = dispatchToolCall(
      { function: { name: 'read_file', arguments: { path: 'nope.ts' } } },
      ws,
    );
    expect(r.text).toMatch(/error: file does not exist/);
  });

  it('replace_in_file updates the working set; subsequent read_file shows new content', () => {
    write('src/a.ts', 'one\ntwo\nthree\n');
    const r1 = dispatchToolCall(
      {
        function: {
          name: 'replace_in_file',
          arguments: { path: 'src/a.ts', start_line: 2, end_line: 2, new_text: 'TWO' },
        },
      },
      ws,
    );
    expect(r1.done).toBe(false);
    expect(r1.text).toMatch(/^ok: replaced/);

    const r2 = dispatchToolCall(
      { function: { name: 'read_file', arguments: { path: 'src/a.ts' } } },
      ws,
    );
    expect(r2.text).toContain('   2 | TWO');
    expect(r2.text).not.toContain('   2 | two');
  });

  it('replace_in_file rejects non-integer line coords with a clear message', () => {
    write('src/a.ts', 'x\n');
    const r = dispatchToolCall(
      {
        function: {
          name: 'replace_in_file',
          arguments: { path: 'src/a.ts', start_line: 'one', end_line: 1, new_text: 'X' },
        },
      },
      ws,
    );
    expect(r.text).toMatch(/start_line and end_line must be integers/);
  });

  it('create_file adds a new file; second create_file with same path errors', () => {
    const ok = dispatchToolCall(
      {
        function: { name: 'create_file', arguments: { path: 'src/new.ts', content: 'hello\n' } },
      },
      ws,
    );
    expect(ok.text).toMatch(/^ok: created/);

    const dup = dispatchToolCall(
      {
        function: { name: 'create_file', arguments: { path: 'src/new.ts', content: 'world' } },
      },
      ws,
    );
    expect(dup.text).toMatch(/already exists/);
  });

  it('delete_file removes from working set; read_file then errors', () => {
    write('src/a.ts', 'x\n');
    const r1 = dispatchToolCall(
      { function: { name: 'delete_file', arguments: { path: 'src/a.ts' } } },
      ws,
    );
    expect(r1.text).toMatch(/^ok: deleted/);

    const r2 = dispatchToolCall(
      { function: { name: 'read_file', arguments: { path: 'src/a.ts' } } },
      ws,
    );
    expect(r2.text).toMatch(/error: file does not exist/);
  });

  it('done returns done:true', () => {
    const r = dispatchToolCall({ function: { name: 'done', arguments: {} } }, ws);
    expect(r.done).toBe(true);
    expect(r.text).toMatch(/finalized/);
  });

  it('unknown tool name returns an error result, never throws', () => {
    const r = dispatchToolCall(
      { function: { name: 'fly_to_moon', arguments: {} } },
      ws,
    );
    expect(r.done).toBe(false);
    expect(r.text).toMatch(/unknown tool/);
  });

  // v1.30.1 — scope discipline tests. Policy is built from the task description
  // and enforced at dispatch time so the model can't wander into config files
  // or unrelated source it wasn't asked to touch.
  describe('write policy (v1.30.1 scope discipline)', () => {
    it('blocks replace_in_file on a path not in the allowed set', () => {
      write('packages/api/src/server.ts', 'one\ntwo\n');
      write('packages/api/package.json', '{"name":"@rag-system/api"}\n');
      const policy: WritePolicy = {
        allowed: new Set(['packages/api/src/server.ts']),
        forbiddenPatterns: [/(?:^|\/)package\.json$/],
      };
      const r = dispatchToolCall(
        {
          function: {
            name: 'replace_in_file',
            arguments: { path: 'packages/api/package.json', start_line: 1, end_line: 1, new_text: 'X' },
          },
        },
        ws,
        policy,
      );
      expect(r.text).toMatch(/protected configuration set/);
      expect(r.text).not.toContain('ok:');
    });

    it('blocks create_file when path is not in allowed set (v1.30 scope creep)', () => {
      const policy: WritePolicy = {
        allowed: new Set(['packages/job-system/src/queue.ts']),
        forbiddenPatterns: [],
      };
      const r = dispatchToolCall(
        {
          function: {
            name: 'create_file',
            arguments: { path: 'packages/agents/src/__tests__/vitest-setup.ts', content: 'export {};' },
          },
        },
        ws,
        policy,
      );
      expect(r.text).toMatch(/not named in the task/);
    });

    it('allows the in-scope path through', () => {
      write('src/main.ts', 'x\n');
      const policy: WritePolicy = {
        allowed: new Set(['src/main.ts']),
        forbiddenPatterns: [],
      };
      const r = dispatchToolCall(
        {
          function: {
            name: 'replace_in_file',
            arguments: { path: 'src/main.ts', start_line: 1, end_line: 1, new_text: 'X' },
          },
        },
        ws,
        policy,
      );
      expect(r.text).toMatch(/^ok: replaced/);
    });

    it('lets the operator opt in to a forbidden path by naming it in the task', () => {
      write('packages/api/package.json', '{"deps":{}}\n');
      const policy: WritePolicy = {
        // Task description explicitly names package.json — model is allowed to touch it.
        allowed: new Set(['packages/api/package.json']),
        forbiddenPatterns: [/(?:^|\/)package\.json$/],
      };
      const r = dispatchToolCall(
        {
          function: {
            name: 'replace_in_file',
            arguments: { path: 'packages/api/package.json', start_line: 1, end_line: 1, new_text: '{"deps":{"x":"^1"}}' },
          },
        },
        ws,
        policy,
      );
      expect(r.text).toMatch(/^ok: replaced/);
    });

    it('read_file is unrestricted regardless of policy', () => {
      write('any/file.ts', 'content\n');
      const policy: WritePolicy = {
        allowed: new Set(['only/this.ts']),
        forbiddenPatterns: [/.*/],
      };
      const r = dispatchToolCall(
        { function: { name: 'read_file', arguments: { path: 'any/file.ts' } } },
        ws,
        policy,
      );
      expect(r.text).toContain('content');
      expect(r.text).not.toMatch(/error/);
    });

    it('empty allowed set means no whitelist enforcement (only forbidden list applies)', () => {
      write('any/file.ts', 'x\n');
      const policy: WritePolicy = {
        allowed: new Set(),
        forbiddenPatterns: [/(?:^|\/)package\.json$/],
      };
      const r1 = dispatchToolCall(
        {
          function: {
            name: 'replace_in_file',
            arguments: { path: 'any/file.ts', start_line: 1, end_line: 1, new_text: 'X' },
          },
        },
        ws,
        policy,
      );
      expect(r1.text).toMatch(/^ok: replaced/);
    });
  });

  describe('extractAllowedPaths', () => {
    it('extracts paths with directories and source extensions', () => {
      const out = extractAllowedPaths('Modify packages/api/src/server.ts to add a /version route.');
      expect(out.has('packages/api/src/server.ts')).toBe(true);
    });

    it('extracts multiple paths from a multi-file task', () => {
      const out = extractAllowedPaths(
        'Add deletedAt to src/types.ts. Update list() in src/services/user-service.ts. Add DELETE in src/routes/users.ts.',
      );
      expect(out.has('src/types.ts')).toBe(true);
      expect(out.has('src/services/user-service.ts')).toBe(true);
      expect(out.has('src/routes/users.ts')).toBe(true);
    });

    it('strips leading "./" so model writes match', () => {
      const out = extractAllowedPaths('Edit ./src/foo.ts');
      expect(out.has('src/foo.ts')).toBe(true);
      expect(out.has('./src/foo.ts')).toBe(false);
    });

    it('handles paths inside backticks/quotes/parentheses', () => {
      const out = extractAllowedPaths(
        'Add a method to `packages/job-system/src/queue.ts`. Also touch "src/types.ts" and (src/routes/users.ts).',
      );
      expect(out.has('packages/job-system/src/queue.ts')).toBe(true);
      expect(out.has('src/types.ts')).toBe(true);
      expect(out.has('src/routes/users.ts')).toBe(true);
    });

    it('returns empty set when the task names no specific paths', () => {
      const out = extractAllowedPaths('Fix the bug where users see duplicate emails.');
      expect(out.size).toBe(0);
    });

    it('catches package.json mentions so explicit allow can bypass forbidden', () => {
      const out = extractAllowedPaths('Update packages/api/package.json to add the zod dependency.');
      expect(out.has('packages/api/package.json')).toBe(true);
    });
  });

  describe('isWriteAllowed', () => {
    it('blocks forbidden when not in allowed', () => {
      const r = isWriteAllowed('packages/api/package.json', {
        allowed: new Set(['src/foo.ts']),
        forbiddenPatterns: [/(?:^|\/)package\.json$/],
      });
      expect(r.ok).toBe(false);
    });

    it('allows forbidden when explicitly in allowed (operator opt-in)', () => {
      const r = isWriteAllowed('packages/api/package.json', {
        allowed: new Set(['packages/api/package.json']),
        forbiddenPatterns: [/(?:^|\/)package\.json$/],
      });
      expect(r.ok).toBe(true);
    });
  });

  // v1.30.5 — verify-syntax (brace balance). Catches the structural-placement
  // failure mode from the v1.30.4 benchmark where replace_in_file consumed a
  // closing `});` without restoring it, leaving the file unbalanced. Dispatcher
  // rolls back the WorkingSet and surfaces an error so the model can retry.
  describe('checkBraceBalance', () => {
    it('accepts balanced TS source', () => {
      const r = checkBraceBalance(`
        export function foo(x: number): number {
          if (x > 0) { return x * 2; }
          return 0;
        }
      `);
      expect(r.ok).toBe(true);
    });

    it('rejects net-positive curly imbalance (unclosed brace)', () => {
      const r = checkBraceBalance('function foo() {\n  return 1;\n');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.balance.curly).toBe(1);
        expect(r.reason).toMatch(/unclosed/);
      }
    });

    it('rejects extra closing brace early-exit during scan', () => {
      const r = checkBraceBalance('function foo() { return 1; }}');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/extra closing/);
    });

    it('ignores braces inside strings', () => {
      const r = checkBraceBalance(`const x = "{ unclosed }";\nconst y = '}';\n`);
      expect(r.ok).toBe(true);
    });

    it('ignores braces inside line and block comments', () => {
      const r = checkBraceBalance(`
        // here is a } unmatched
        /* and another { unmatched */
        function ok() { return 1; }
      `);
      expect(r.ok).toBe(true);
    });

    it('handles escape sequences in strings', () => {
      const r = checkBraceBalance(`const s = "she said \\"{}\\" out loud";\n`);
      expect(r.ok).toBe(true);
    });

    it('rejects unbalanced parens', () => {
      const r = checkBraceBalance('function foo( { return 1; }');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.balance.paren).toBeGreaterThan(0);
    });

    it('detects the v1.30.4 "consumed closing brace" pattern', () => {
      // What the model produced on the live /version benchmark — `/version`
      // nested inside `/health`'s body, /health's `});` consumed.
      const broken = `
        app.get('/health', async () => {
          const client = new OllamaClient();
          return { status: 'ok' };

            app.get('/version', async (request, reply) => {
              return { version: '1.0.0' };
            });

          app.post('/task', async (request, reply) => {
            // ...
          });
        }
      `;
      const r = checkBraceBalance(broken);
      expect(r.ok).toBe(false); // file is structurally broken
    });
  });

  describe('replace_in_file with brace-balance verification', () => {
    function setupBalancedFile(): void {
      write(
        'src/server.ts',
        `import { Foo } from './foo.js';

export function buildServer() {
  const app = new App();

  app.get('/health', () => {
    return { status: 'ok' };
  });

  app.post('/task', () => {
    return { id: 1 };
  });

  return app;
}
`,
      );
    }

    it('rolls back when an edit unbalances a previously-balanced file', () => {
      setupBalancedFile();
      const policy: WritePolicy = {
        allowed: new Set(['src/server.ts']),
        forbiddenPatterns: [],
      };

      const before = ws.read('src/server.ts');
      // Replace lines 6-8 (the /health body + closing) with content that does
      // NOT include the closing `});` — mirrors the v1.30.4 failure.
      const r = dispatchToolCall(
        {
          function: {
            name: 'replace_in_file',
            arguments: {
              path: 'src/server.ts',
              start_line: 7,
              end_line: 8,
              new_text: '    return { status: \'broken\' };',
            },
          },
        },
        ws,
        policy,
      );
      expect(r.text).toMatch(/unbalanced/);
      expect(r.text).toMatch(/rolled back/);
      expect(ws.read('src/server.ts')).toBe(before);
    });

    it('allows balanced edits through unchanged', () => {
      setupBalancedFile();
      const policy: WritePolicy = {
        allowed: new Set(['src/server.ts']),
        forbiddenPatterns: [],
      };

      // Replace just the body line of /health — keeps braces balanced.
      const r = dispatchToolCall(
        {
          function: {
            name: 'replace_in_file',
            arguments: {
              path: 'src/server.ts',
              start_line: 7,
              end_line: 7,
              new_text: '    return { status: \'ok\', uptime: 42 };',
            },
          },
        },
        ws,
        policy,
      );
      expect(r.text).toMatch(/^ok: replaced/);
      expect(ws.read('src/server.ts')).toContain('uptime: 42');
    });

    it('does not balance-check non-source files (e.g. .md)', () => {
      write('README.md', '# Title\n\nSome { unbalanced text on purpose.\n');
      const policy: WritePolicy = {
        allowed: new Set(['README.md']),
        forbiddenPatterns: [],
      };
      const r = dispatchToolCall(
        {
          function: {
            name: 'replace_in_file',
            arguments: { path: 'README.md', start_line: 1, end_line: 1, new_text: '# New Title' },
          },
        },
        ws,
        policy,
      );
      expect(r.text).toMatch(/^ok: replaced/);
    });
  });

  describe('create_file with brace-balance pre-check', () => {
    it('rejects creating a TS file with unbalanced content', () => {
      const policy: WritePolicy = {
        allowed: new Set(['src/broken.ts']),
        forbiddenPatterns: [],
      };
      const r = dispatchToolCall(
        {
          function: {
            name: 'create_file',
            arguments: {
              path: 'src/broken.ts',
              content: 'export function foo() {\n  return 1;\n', // missing }
            },
          },
        },
        ws,
        policy,
      );
      expect(r.text).toMatch(/structurally unbalanced/);
      expect(ws.exists('src/broken.ts')).toBe(false); // not created
    });

    it('allows creating a balanced TS file', () => {
      const policy: WritePolicy = {
        allowed: new Set(['src/clean.ts']),
        forbiddenPatterns: [],
      };
      const r = dispatchToolCall(
        {
          function: {
            name: 'create_file',
            arguments: {
              path: 'src/clean.ts',
              content: 'export function foo() {\n  return 1;\n}\n',
            },
          },
        },
        ws,
        policy,
      );
      expect(r.text).toMatch(/^ok: created/);
      expect(ws.exists('src/clean.ts')).toBe(true);
    });

    it('skips balance check for non-source files (e.g. .md, .json)', () => {
      const policy: WritePolicy = {
        allowed: new Set(['notes.md', 'data.json']),
        forbiddenPatterns: [],
      };
      const r1 = dispatchToolCall(
        {
          function: {
            name: 'create_file',
            arguments: { path: 'notes.md', content: '# Has unbalanced { brace' },
          },
        },
        ws,
        policy,
      );
      expect(r1.text).toMatch(/^ok: created/);
    });
  });

  it('full edit flow: read → replace → done → toFileChanges has the modified content', () => {
    write('src/main.ts', "console.log('hello');\nexport {};\n");
    dispatchToolCall(
      { function: { name: 'read_file', arguments: { path: 'src/main.ts' } } },
      ws,
    );
    dispatchToolCall(
      {
        function: {
          name: 'replace_in_file',
          arguments: {
            path: 'src/main.ts',
            start_line: 1,
            end_line: 1,
            new_text: "console.log('world');",
          },
        },
      },
      ws,
    );
    const done = dispatchToolCall({ function: { name: 'done', arguments: {} } }, ws);
    expect(done.done).toBe(true);

    const changes = ws.toFileChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].action).toBe('create');
    expect(changes[0].path).toBe('src/main.ts');
    if (changes[0].action === 'create') {
      expect(changes[0].content).toBe("console.log('world');\nexport {};\n");
    }
  });
});

describe('dispatchToolCall — structural tools (v1.31)', () => {
  let tmpDir: string;
  let ws: WorkingSet;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-struct-'));
    ws = new WorkingSet(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  it('add_route inserts a new Fastify route after the existing one', () => {
    write(
      'src/server.ts',
      [
        'export async function buildServer() {',
        '  const app = Fastify();',
        "  app.get('/health', async () => ({ status: 'ok' }));",
        '  return app;',
        '}',
        '',
      ].join('\n'),
    );

    const r = dispatchToolCall(
      {
        function: {
          name: 'add_route',
          arguments: {
            file: 'src/server.ts',
            http_method: 'GET',
            route_path: '/version',
            body: "return { version: '1.0.0' };",
          },
        },
      },
      ws,
    );

    expect(r.text.startsWith('ok:')).toBe(true);
    const after = ws.read('src/server.ts')!;
    expect(after).toContain("app.get('/version', async (request, reply) => {");
    expect(after).toContain("return { version: '1.0.0' };");
    // /health untouched
    expect(after).toContain("app.get('/health', async () => ({ status: 'ok' }));");
  });

  it('add_method inserts a new method into a named class', () => {
    write(
      'src/svc.ts',
      [
        'export class UserService {',
        '  list(): string[] {',
        "    return [];",
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const r = dispatchToolCall(
      {
        function: {
          name: 'add_method',
          arguments: {
            file: 'src/svc.ts',
            container: 'UserService',
            source: 'getSize(): number {\n  return this.list().length;\n}',
          },
        },
      },
      ws,
    );

    expect(r.text.startsWith('ok:')).toBe(true);
    const after = ws.read('src/svc.ts')!;
    expect(after).toContain('getSize(): number {');
    expect(after).toContain('return this.list().length;');
  });

  it('replace_method rewrites an existing method body', () => {
    write(
      'src/svc.ts',
      ['class Foo {', '  bar(): number { return 1; }', '}', ''].join('\n'),
    );

    const r = dispatchToolCall(
      {
        function: {
          name: 'replace_method',
          arguments: {
            file: 'src/svc.ts',
            container: 'Foo',
            name: 'bar',
            source: 'bar(): number { return 99; }',
          },
        },
      },
      ws,
    );

    expect(r.text.startsWith('ok:')).toBe(true);
    expect(ws.read('src/svc.ts')!).toContain('return 99;');
    expect(ws.read('src/svc.ts')!).not.toContain('return 1;');
  });

  it('replace_function rewrites a top-level function', () => {
    write('src/util.ts', 'export function add(a: number, b: number) { return a + b; }\n');

    const r = dispatchToolCall(
      {
        function: {
          name: 'replace_function',
          arguments: {
            file: 'src/util.ts',
            name: 'add',
            source: 'export function add(a: number, b: number) { return a - b; }',
          },
        },
      },
      ws,
    );

    expect(r.text.startsWith('ok:')).toBe(true);
    expect(ws.read('src/util.ts')!).toContain('return a - b;');
  });

  it('add_import adds a new import after the last existing import', () => {
    write(
      'src/server.ts',
      ["import Fastify from 'fastify';", '', 'export const X = 1;', ''].join('\n'),
    );

    const r = dispatchToolCall(
      {
        function: {
          name: 'add_import',
          arguments: {
            file: 'src/server.ts',
            source: './logger.js',
            names: ['logger'],
          },
        },
      },
      ws,
    );

    expect(r.text.startsWith('ok:')).toBe(true);
    expect(ws.read('src/server.ts')!).toContain("import { logger } from './logger.js';");
  });

  it('add_import is idempotent — returns ok with "no change" when names already imported', () => {
    write('src/a.ts', "import { x } from './lib.js';\nexport {};\n");

    const r = dispatchToolCall(
      {
        function: {
          name: 'add_import',
          arguments: {
            file: 'src/a.ts',
            source: './lib.js',
            names: ['x'],
          },
        },
      },
      ws,
    );

    expect(r.text).toMatch(/ok: no change/);
    // File untouched
    expect(ws.read('src/a.ts')!).toBe("import { x } from './lib.js';\nexport {};\n");
  });

  it('add_export appends a new top-level export', () => {
    write('src/types.ts', "export const A = 1;\n");

    const r = dispatchToolCall(
      {
        function: {
          name: 'add_export',
          arguments: {
            file: 'src/types.ts',
            source: 'export const B = 2;',
          },
        },
      },
      ws,
    );

    expect(r.text.startsWith('ok:')).toBe(true);
    expect(ws.read('src/types.ts')!).toMatch(/export const A = 1;\s+export const B = 2;/);
  });

  it('structural tools enforce scope discipline (path not in allowed)', () => {
    write('src/server.ts', 'export class Foo {}\n');
    write('src/other.ts', 'export class Foo {}\n');

    const policy: WritePolicy = {
      allowed: new Set(['src/server.ts']),
      forbiddenPatterns: [],
    };

    const r = dispatchToolCall(
      {
        function: {
          name: 'add_method',
          arguments: {
            file: 'src/other.ts',
            container: 'Foo',
            source: 'bar() {}',
          },
        },
      },
      ws,
      policy,
    );

    expect(r.text).toMatch(/^error:/);
    expect(r.text).toMatch(/not named in the task/);
    // File untouched
    expect(ws.read('src/other.ts')!).toBe('export class Foo {}\n');
  });

  it('structural tools surface locator errors verbatim', () => {
    write('src/svc.ts', 'export class Foo {}\n');

    const r = dispatchToolCall(
      {
        function: {
          name: 'replace_method',
          arguments: {
            file: 'src/svc.ts',
            container: 'Foo',
            name: 'missing',
            source: 'missing() {}',
          },
        },
      },
      ws,
    );

    expect(r.text).toMatch(/^error:/);
    expect(r.text).toMatch(/method Foo\.missing not found/);
  });

  it('structural tools refuse forbidden config files (package.json) by default', () => {
    write('package.json', '{"name":"test"}\n');

    const policy: WritePolicy = {
      allowed: new Set(),
      forbiddenPatterns: [/(?:^|\/)package\.json$/],
    };

    const r = dispatchToolCall(
      {
        function: {
          name: 'add_export',
          arguments: {
            file: 'package.json',
            source: 'export const X = 1;',
          },
        },
      },
      ws,
      policy,
    );

    expect(r.text).toMatch(/^error:/);
    expect(r.text).toMatch(/protected configuration set/);
  });

  it('add_method on a non-existent file fails cleanly (must use create_file first)', () => {
    const r = dispatchToolCall(
      {
        function: {
          name: 'add_method',
          arguments: {
            file: 'src/missing.ts',
            container: 'Foo',
            source: 'bar() {}',
          },
        },
      },
      ws,
    );

    expect(r.text).toMatch(/^error:/);
    expect(r.text).toMatch(/file does not exist/);
    expect(r.text).toMatch(/create_file/);
  });

  it('structural tools require a non-empty file argument', () => {
    const r = dispatchToolCall(
      {
        function: {
          name: 'add_route',
          arguments: {
            http_method: 'GET',
            route_path: '/x',
            body: 'return {};',
          },
        },
      },
      ws,
    );

    expect(r.text).toMatch(/^error:/);
    expect(r.text).toMatch(/requires a non-empty "file" argument/);
  });
});
