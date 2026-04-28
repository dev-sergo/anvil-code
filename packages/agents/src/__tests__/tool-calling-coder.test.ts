import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { dispatchToolCall, TOOL_DEFINITIONS } from '../tool-calling-coder.js';
import { WorkingSet } from '../working-set.js';

describe('TOOL_DEFINITIONS', () => {
  it('exposes the five expected tools', () => {
    const names = TOOL_DEFINITIONS.map(t => t.function.name);
    expect(names).toEqual(['read_file', 'replace_in_file', 'create_file', 'delete_file', 'done']);
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
