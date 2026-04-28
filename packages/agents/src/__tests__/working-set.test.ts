import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { WorkingSet } from '../working-set.js';

describe('WorkingSet', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'working-set-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  it('reads disk content lazily on first access', () => {
    write('src/a.ts', 'line1\nline2\n');
    const ws = new WorkingSet(tmpDir);
    expect(ws.read('src/a.ts')).toBe('line1\nline2\n');
  });

  it('returns null for non-existent files', () => {
    const ws = new WorkingSet(tmpDir);
    expect(ws.read('does-not-exist.ts')).toBeNull();
    expect(ws.exists('does-not-exist.ts')).toBe(false);
  });

  it('replace mutates the line range and subsequent reads see the new content', () => {
    write('src/a.ts', 'one\ntwo\nthree\nfour\n');
    const ws = new WorkingSet(tmpDir);
    const r = ws.replace('src/a.ts', 2, 3, 'TWO\nTHREE');
    expect(r.ok).toBe(true);
    expect(ws.read('src/a.ts')).toBe('one\nTWO\nTHREE\nfour\n');
  });

  it('replace with empty newText deletes the line range', () => {
    write('src/a.ts', 'one\ntwo\nthree\nfour\n');
    const ws = new WorkingSet(tmpDir);
    const r = ws.replace('src/a.ts', 2, 3, '');
    expect(r.ok).toBe(true);
    expect(ws.read('src/a.ts')).toBe('one\nfour\n');
  });

  it('replace allows multi-line insertion expanding the file', () => {
    write('src/a.ts', 'one\ntwo\nthree\n');
    const ws = new WorkingSet(tmpDir);
    const r = ws.replace('src/a.ts', 2, 2, 'TWO_A\nTWO_B\nTWO_C');
    expect(r.ok).toBe(true);
    expect(ws.read('src/a.ts')).toBe('one\nTWO_A\nTWO_B\nTWO_C\nthree\n');
  });

  it('rejects out-of-range line coordinates with informative error', () => {
    write('src/a.ts', 'one\ntwo\n');  // 3 lines after split (incl. trailing empty)
    const ws = new WorkingSet(tmpDir);
    const r = ws.replace('src/a.ts', 1, 99, 'X');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/out of range/);
  });

  it('rejects start_line < 1 and end_line < start_line', () => {
    write('src/a.ts', 'one\ntwo\n');
    const ws = new WorkingSet(tmpDir);
    expect(ws.replace('src/a.ts', 0, 1, 'X').ok).toBe(false);
    expect(ws.replace('src/a.ts', 2, 1, 'X').ok).toBe(false);
  });

  it('rejects replace on non-existent files (must create_file first)', () => {
    const ws = new WorkingSet(tmpDir);
    const r = ws.replace('new.ts', 1, 1, 'X');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/does not exist/);
  });

  it('create adds a new file; rejects duplicates', () => {
    const ws = new WorkingSet(tmpDir);
    expect(ws.create('new.ts', 'hello\n').ok).toBe(true);
    expect(ws.read('new.ts')).toBe('hello\n');
    const dup = ws.create('new.ts', 'world\n');
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toMatch(/already exists/);
  });

  it('delete marks a file for removal; subsequent reads return null', () => {
    write('src/a.ts', 'content\n');
    const ws = new WorkingSet(tmpDir);
    expect(ws.exists('src/a.ts')).toBe(true);
    expect(ws.delete('src/a.ts').ok).toBe(true);
    expect(ws.read('src/a.ts')).toBeNull();
    expect(ws.exists('src/a.ts')).toBe(false);
  });

  it('cannot delete a file that does not exist', () => {
    const ws = new WorkingSet(tmpDir);
    const r = ws.delete('nope.ts');
    expect(r.ok).toBe(false);
  });

  it('toFileChanges produces correct shape — create, modify, delete, and skips untouched', () => {
    write('src/touched.ts', 'old\n');
    write('src/skipped.ts', 'unchanged\n');
    write('src/gone.ts', 'will be deleted\n');
    const ws = new WorkingSet(tmpDir);

    // touch each in different ways
    ws.read('src/skipped.ts'); // read but don't modify → untouched
    ws.replace('src/touched.ts', 1, 1, 'new');
    ws.create('src/fresh.ts', 'brand new\n');
    ws.delete('src/gone.ts');

    const changes = ws.toFileChanges();
    expect(changes).toHaveLength(3);
    const byPath = new Map(changes.map(c => [c.path, c]));

    const touched = byPath.get('src/touched.ts')!;
    expect(touched.action).toBe('create'); // modify rendered as overwrite-create
    if (touched.action === 'create') expect(touched.content).toBe('new\n');

    const fresh = byPath.get('src/fresh.ts')!;
    expect(fresh.action).toBe('create');
    if (fresh.action === 'create') expect(fresh.content).toBe('brand new\n');

    expect(byPath.get('src/gone.ts')!.action).toBe('delete');
    expect(byPath.get('src/skipped.ts')).toBeUndefined();
  });

  it('hasChanges() distinguishes "did nothing" from real edits', () => {
    write('src/a.ts', 'x\n');
    const ws = new WorkingSet(tmpDir);
    ws.read('src/a.ts');
    expect(ws.hasChanges()).toBe(false); // pure read
    ws.replace('src/a.ts', 1, 1, 'X');
    expect(ws.hasChanges()).toBe(true);
  });

  it('a file created in-loop, then replaced, stays as create (not modify)', () => {
    const ws = new WorkingSet(tmpDir);
    ws.create('new.ts', 'one\ntwo\n');
    ws.replace('new.ts', 1, 1, 'ONE');
    const changes = ws.toFileChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].action).toBe('create');
    if (changes[0].action === 'create') expect(changes[0].content).toBe('ONE\ntwo\n');
  });
});
