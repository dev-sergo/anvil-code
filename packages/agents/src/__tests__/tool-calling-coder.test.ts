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
import type { ToolLoopMessage } from '@rag-system/model-router';
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

  it('read_file with start_line shows the correct window (v1.63)', () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    write('src/big.ts', content);
    const r = dispatchToolCall(
      { function: { name: 'read_file', arguments: { path: 'src/big.ts', start_line: 5 } } },
      ws,
    );
    expect(r.done).toBe(false);
    expect(r.text).toContain('   5 | line5');
    expect(r.text).toContain('  10 | line10');
    expect(r.text).not.toContain('   1 | line1');
  });

  it('read_file truncation message contains add_export hint and exact start_line (v1.63)', () => {
    // Create a file with more lines than MAX_READ_LINES (350)
    const lines = Array.from({ length: 400 }, (_, i) => `export const x${i} = ${i};`);
    write('src/large.ts', lines.join('\n'));
    const r = dispatchToolCall(
      { function: { name: 'read_file', arguments: { path: 'src/large.ts' } } },
      ws,
    );
    expect(r.text).toContain('add_export');
    expect(r.text).toMatch(/start_line=\d+/);
    // Should NOT contain the old incorrect advice
    expect(r.text).not.toContain('Use replace_in_file with known line numbers for lower sections');
  });

  it('read_file with start_line at file end shows no truncation suffix', () => {
    const content = Array.from({ length: 5 }, (_, i) => `line${i + 1}`).join('\n');
    write('src/small.ts', content);
    const r = dispatchToolCall(
      { function: { name: 'read_file', arguments: { path: 'src/small.ts', start_line: 3 } } },
      ws,
    );
    expect(r.text).toContain('   3 | line3');
    expect(r.text).toContain('   5 | line5');
    expect(r.text).not.toContain('[Showing lines');
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

  // v1.32-a.1 — read-grants-write. A file the model has explicitly read in
  // this loop is granted write access. Surfaced by L4.1: Fixer correctly
  // navigated to user-service.ts via read_file but couldn't write there.
  describe('isWriteAllowed with read-grants-write (v1.32-a.1)', () => {
    let tmpDir: string;
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iwa-rgw-'));
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function write(rel: string, content: string): void {
      const abs = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }

    const policy: WritePolicy = {
      allowed: new Set(['src/coder-output.ts']),
      forbiddenPatterns: [/(?:^|\/)package\.json$/],
    };

    it('rejects an unread out-of-scope file', () => {
      const ws = new WorkingSet(tmpDir);
      const r = isWriteAllowed('src/elsewhere.ts', policy, ws);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/not opened via read_file/);
    });

    it('grants write after an explicit read_file in the same loop', () => {
      write('src/elsewhere.ts', 'export const X = 1;\n');
      const ws = new WorkingSet(tmpDir);
      // Pre-condition: write rejected before read.
      expect(isWriteAllowed('src/elsewhere.ts', policy, ws).ok).toBe(false);
      // Read it (mimics what dispatchToolCall does on read_file).
      ws.read('src/elsewhere.ts');
      // Now writable.
      expect(isWriteAllowed('src/elsewhere.ts', policy, ws).ok).toBe(true);
    });

    it('still blocks forbidden config files even after read_file (absolute ban)', () => {
      write('package.json', '{}\n');
      const ws = new WorkingSet(tmpDir);
      ws.read('package.json');
      const r = isWriteAllowed('package.json', policy, ws);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/protected configuration/);
    });

    it('keeps the static allowed set as the primary path (no read needed for it)', () => {
      const ws = new WorkingSet(tmpDir);
      // src/coder-output.ts is in policy.allowed; never read.
      expect(isWriteAllowed('src/coder-output.ts', policy, ws).ok).toBe(true);
    });

    it('does not leak between independent WorkingSet instances', () => {
      write('src/elsewhere.ts', 'x\n');
      const ws1 = new WorkingSet(tmpDir);
      const ws2 = new WorkingSet(tmpDir);
      ws1.read('src/elsewhere.ts'); // ws1 has it opened, ws2 does not
      expect(isWriteAllowed('src/elsewhere.ts', policy, ws1).ok).toBe(true);
      expect(isWriteAllowed('src/elsewhere.ts', policy, ws2).ok).toBe(false);
    });

    it('a file opened then deleted in the same loop is not writable again', () => {
      write('src/temp.ts', 'x\n');
      const ws = new WorkingSet(tmpDir);
      ws.read('src/temp.ts');
      ws.delete('src/temp.ts');
      // After delete, hasOpened returns false; subsequent write rejected.
      expect(isWriteAllowed('src/temp.ts', policy, ws).ok).toBe(false);
    });

    it('back-compat: omitting `ws` falls back to static-policy behavior', () => {
      // Pre-v1.32-a.1 callers (and unit tests) call isWriteAllowed(path, policy).
      // The third arg is optional; without it, only the static rules apply.
      const r = isWriteAllowed('src/elsewhere.ts', policy);
      expect(r.ok).toBe(false);
    });
  });

  // v1.32-a.1 dispatcher integration — read_file in the loop unlocks
  // subsequent writes through the actual tool dispatcher (not just the
  // unit-tested helper). This is the live behavior model relies on.
  describe('dispatchToolCall — read-grants-write end-to-end (v1.32-a.1)', () => {
    let tmpDir: string;
    let ws: WorkingSet;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgw-dispatch-'));
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

    it('replace_in_file on an out-of-scope file is rejected before read; succeeds after', () => {
      write('src/services/user-service.ts', 'export const x = 1;\nexport const y = 2;\n');
      const policy: WritePolicy = {
        allowed: new Set(['src/routes/users.ts']),
        forbiddenPatterns: [],
      };

      // Step 1: try to write before reading. Rejected.
      const beforeRead = dispatchToolCall(
        {
          function: {
            name: 'replace_in_file',
            arguments: {
              path: 'src/services/user-service.ts',
              start_line: 1,
              end_line: 1,
              new_text: 'export const x = 99;',
            },
          },
        },
        ws,
        policy,
      );
      expect(beforeRead.text).toMatch(/^error:/);
      expect(beforeRead.text).toMatch(/not opened via read_file/);

      // Step 2: read the file.
      const readResult = dispatchToolCall(
        {
          function: { name: 'read_file', arguments: { path: 'src/services/user-service.ts' } },
        },
        ws,
        policy,
      );
      expect(readResult.text.startsWith('# src/services/user-service.ts')).toBe(true);

      // Step 3: write succeeds.
      const afterRead = dispatchToolCall(
        {
          function: {
            name: 'replace_in_file',
            arguments: {
              path: 'src/services/user-service.ts',
              start_line: 1,
              end_line: 1,
              new_text: 'export const x = 99;',
            },
          },
        },
        ws,
        policy,
      );
      expect(afterRead.text.startsWith('ok:')).toBe(true);
      expect(ws.read('src/services/user-service.ts')).toContain('export const x = 99;');
    });

    it('add_method on a read file unlocks even when class is in a non-allowlisted module', () => {
      // Specifically replays the L4.1 navigation pattern: bug is in a service
      // module the Coder didn't touch; Fixer reads it, then edits via a
      // structural tool (which goes through the same scope check).
      write(
        'src/services/user-service.ts',
        'export class UserService {\n  list(): string[] {\n    return [];\n  }\n}\n',
      );
      const policy: WritePolicy = {
        allowed: new Set(['src/routes/users.ts']),
        forbiddenPatterns: [],
      };

      // Read first.
      dispatchToolCall(
        { function: { name: 'read_file', arguments: { path: 'src/services/user-service.ts' } } },
        ws,
        policy,
      );

      const r = dispatchToolCall(
        {
          function: {
            name: 'add_method',
            arguments: {
              file: 'src/services/user-service.ts',
              container: 'UserService',
              source: 'getSize(): number { return this.list().length; }',
            },
          },
        },
        ws,
        policy,
      );
      expect(r.text.startsWith('ok:')).toBe(true);
      const updated = ws.read('src/services/user-service.ts')!;
      expect(updated).toContain('getSize(): number');
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

// v1.32-a.3 — Coder reliability: symmetric to Fixer's retry logic. The earlier
// one-shot retry with "Or call done() if there is nothing to do" gave the
// model an explicit bail option on hard tasks. New behavior: two retries
// with stronger nudges; bail only after 3 consecutive text-only responses.
describe('ToolCallingCoderAgent.execute — no-tool-calls retry (v1.32-a.3)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-no-tools-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildFakeRouter(responses: Array<{ content: string; toolCalls?: unknown[] }>) {
    let i = 0;
    return {
      routeWithTools: async () => {
        const r = responses[Math.min(i, responses.length - 1)];
        i++;
        return { content: r.content, toolCalls: r.toolCalls, model: 'fake' };
      },
    } as never;
  }

  it('bails after 3 consecutive text-only responses', async () => {
    const { ToolCallingCoderAgent } = await import('../tool-calling-coder.js');
    const router = buildFakeRouter([
      { content: 'I do not know how to do this.' },
      { content: 'Still no.' },
      { content: 'Genuinely stuck.' },
    ]);
    const agent = new ToolCallingCoderAgent(router);
    const result = await agent.execute('add a /version endpoint', 'context', 'balanced', tmpDir);
    expect(result.files).toEqual([]);
  });

  it('continues normally when a text-only response is followed by tool calls', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src/foo.ts'), 'export const X = 1;\n');

    const { ToolCallingCoderAgent } = await import('../tool-calling-coder.js');
    const router = buildFakeRouter([
      { content: 'thinking…' }, // text only — triggers nudge #1
      { content: '', toolCalls: [{ function: { name: 'read_file', arguments: { path: 'src/foo.ts' } } }] },
      { content: '', toolCalls: [{ function: { name: 'done', arguments: {} } }] },
    ]);
    const agent = new ToolCallingCoderAgent(router);
    const result = await agent.execute('inspect src/foo.ts', 'context', 'balanced', tmpDir);
    // Coder only read; no edits. Key property: the loop didn't bail at the
    // first text-only response — the read_file in round 2 was reached.
    expect(result.files).toEqual([]);
  });
});

// v1.32-a.5 — pathology guard: detect "stuck on same (tool + path) tuple
// with repeated errors" and break early. Surfaced by L4.1 v1.32-a.4 run #1
// where Coder spent 58 minutes retrying near-identical replace_in_file
// calls that brace-balance kept rejecting. Tests verify the threshold-based
// nudge + hard-bail logic.
describe('ToolCallingCoderAgent.execute — pathology guard (v1.32-a.5)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-pathology-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: a router that always emits the same replace_in_file call, which
  // reliably errors because the target file does not exist on disk. Each
  // call increments invocations counter; messages snapshot saved to inspect
  // what nudges the loop pushed between calls.
  function buildErrorRouter(): { invocations: () => number; messageSnapshots: ToolLoopMessage[][]; router: unknown } {
    let count = 0;
    const messageSnapshots: ToolLoopMessage[][] = [];
    const router = {
      routeWithTools: async (_role: unknown, msgs: ToolLoopMessage[]) => {
        count++;
        messageSnapshots.push([...msgs]);
        return {
          content: '',
          toolCalls: [{
            function: {
              name: 'replace_in_file',
              arguments: { path: 'src/missing.ts', start_line: 1, end_line: 1, new_text: 'X' },
            },
          }],
          model: 'fake',
        };
      },
    } as never;
    return { invocations: () => count, messageSnapshots, router };
  }

  it('pushes a strategy nudge after PATHOLOGY_THRESHOLD consecutive same-fingerprint errors', async () => {
    const { invocations, messageSnapshots, router } = buildErrorRouter();
    const { ToolCallingCoderAgent, PATHOLOGY_THRESHOLD } = await import('../tool-calling-coder.js');
    const agent = new ToolCallingCoderAgent(router as never);
    await agent.execute('try to edit a missing file', 'context', 'balanced', tmpDir);

    // First nudge fires after PATHOLOGY_THRESHOLD errors. The next router
    // invocation (PATHOLOGY_THRESHOLD + 1 = 6th call) sees the nudge in messages.
    expect(invocations()).toBeGreaterThanOrEqual(PATHOLOGY_THRESHOLD + 1);
    const callAfterNudge = messageSnapshots[PATHOLOGY_THRESHOLD]!;
    const lastUser = [...callAfterNudge].reverse().find(m => m.role === 'user')!;
    expect(lastUser.content).toMatch(/change strategy/i);
    expect(lastUser.content).toMatch(/replace_in_file/);
  });

  it('hard-bails after MAX_PATHOLOGY_STRIKES same-fingerprint cycles', async () => {
    const { invocations, router } = buildErrorRouter();
    const { ToolCallingCoderAgent, PATHOLOGY_THRESHOLD, MAX_PATHOLOGY_STRIKES } = await import('../tool-calling-coder.js');
    const agent = new ToolCallingCoderAgent(router as never);
    await agent.execute('always errors', 'context', 'balanced', tmpDir);

    // Each strike consumes PATHOLOGY_THRESHOLD calls. After MAX_PATHOLOGY_STRIKES
    // strikes, the loop bails. Total tool calls = THRESHOLD * MAX_STRIKES (10 by default).
    const expected = PATHOLOGY_THRESHOLD * MAX_PATHOLOGY_STRIKES;
    expect(invocations()).toBe(expected);
  });

  it('a successful tool call resets the consecutive-error counter (model can iterate without triggering pathology)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'real.ts'), 'export const X = 1;\n');

    // Pattern: every 5th call succeeds; counter resets each time. Pathology
    // never fires; loop runs to MAX_TOOL_CALLS budget (or hits some other
    // termination — neither nudge nor bail should fire).
    let count = 0;
    const router = {
      routeWithTools: async () => {
        count++;
        const fail = count % 5 !== 0;
        return {
          content: '',
          toolCalls: [{
            function: fail
              ? { name: 'replace_in_file', arguments: { path: 'src/missing.ts', start_line: 1, end_line: 1, new_text: 'X' } }
              : { name: 'read_file', arguments: { path: 'real.ts' } },
          }],
          model: 'fake',
        };
      },
    } as never;

    const { ToolCallingCoderAgent } = await import('../tool-calling-coder.js');
    const agent = new ToolCallingCoderAgent(router);
    await agent.execute('mixed pattern', 'context', 'balanced', tmpDir);

    // 50 = MAX_TOOL_CALLS budget. If pathology bailed early, count < 50.
    expect(count).toBe(50);
  });

  it('a different-fingerprint error resets the counter (alternating files do not trigger pathology)', async () => {
    // 4 errors on file A, then 4 errors on file B, then 4 on A, ...
    // Each switch resets the counter; THRESHOLD never reached.
    let count = 0;
    const router = {
      routeWithTools: async () => {
        count++;
        const fileA = Math.floor((count - 1) / 4) % 2 === 0;
        return {
          content: '',
          toolCalls: [{
            function: {
              name: 'replace_in_file',
              arguments: {
                path: fileA ? 'src/a.ts' : 'src/b.ts',
                start_line: 1,
                end_line: 1,
                new_text: 'X',
              },
            },
          }],
          model: 'fake',
        };
      },
    } as never;

    const { ToolCallingCoderAgent } = await import('../tool-calling-coder.js');
    const agent = new ToolCallingCoderAgent(router);
    await agent.execute('alternating bad paths', 'context', 'balanced', tmpDir);

    // No bail because no fingerprint reaches the THRESHOLD; loop runs the
    // full MAX_TOOL_CALLS budget.
    expect(count).toBe(50);
  });
});
