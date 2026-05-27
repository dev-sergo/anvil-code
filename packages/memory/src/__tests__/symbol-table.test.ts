import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SymbolTable } from '../symbol-table.js';
import type { CodeSymbol } from '@rag-system/code-graph';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS symbols (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      kind         TEXT NOT NULL,
      file_path    TEXT NOT NULL,
      start_line   INTEGER NOT NULL,
      end_line     INTEGER NOT NULL,
      body         TEXT,
      package_name TEXT,
      UNIQUE(name, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);

    CREATE TABLE IF NOT EXISTS dependencies (
      from_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      to_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      PRIMARY KEY (from_id, to_id)
    );
    CREATE INDEX IF NOT EXISTS idx_deps_to ON dependencies(to_id);
  `);
  return db;
}

function sym(name: string, filePath = '/pkg/src/a.ts', kind: CodeSymbol['kind'] = 'function'): CodeSymbol {
  return { name, kind, filePath, startLine: 1, endLine: 10, text: `function ${name}() {}` };
}

let db: Database.Database;
let table: SymbolTable;

beforeEach(() => {
  db = makeDb();
  table = new SymbolTable(db);
});

afterEach(() => {
  db.close();
});

describe('SymbolTable.upsertFile', () => {
  it('inserts symbols from a file', () => {
    table.upsertFile('/pkg/src/a.ts', [sym('foo'), sym('bar')]);
    expect(table.symbolCount).toBe(2);
  });

  it('is idempotent — re-running same file does not duplicate symbols', () => {
    table.upsertFile('/pkg/src/a.ts', [sym('foo'), sym('bar')]);
    table.upsertFile('/pkg/src/a.ts', [sym('foo'), sym('bar')]);
    expect(table.symbolCount).toBe(2);
  });

  it('replaces symbols when file content changes', () => {
    table.upsertFile('/pkg/src/a.ts', [sym('foo'), sym('bar')]);
    table.upsertFile('/pkg/src/a.ts', [sym('baz')]);
    expect(table.symbolCount).toBe(1);
    const rows = db.prepare('SELECT name FROM symbols').all() as Array<{ name: string }>;
    expect(rows[0].name).toBe('baz');
  });

  it('stores packageName when provided', () => {
    table.upsertFile('/pkg/src/a.ts', [sym('foo')], { packageName: 'pkg' });
    const row = db.prepare('SELECT package_name FROM symbols WHERE name = ?').get('foo') as { package_name: string };
    expect(row.package_name).toBe('pkg');
  });

  it('inserts dependency edges via extractDeps', () => {
    table.upsertFile('/pkg/src/a.ts', [sym('foo'), sym('bar')]);
    table.upsertFile('/pkg/src/b.ts', [sym('baz', '/pkg/src/b.ts')], {
      extractDeps: () => ['foo'],
    });
    expect(table.edgeCount).toBe(1);
  });
});

describe('SymbolTable.removeFile', () => {
  it('removes all symbols for the file', () => {
    table.upsertFile('/pkg/src/a.ts', [sym('foo'), sym('bar')]);
    table.removeFile('/pkg/src/a.ts');
    expect(table.symbolCount).toBe(0);
  });

  it('cascades to dependency edges', () => {
    table.upsertFile('/pkg/src/a.ts', [sym('foo')]);
    table.upsertFile('/pkg/src/b.ts', [sym('bar', '/pkg/src/b.ts')], {
      extractDeps: () => ['foo'],
    });
    expect(table.edgeCount).toBe(1);
    // Removing the caller file removes its edge
    table.removeFile('/pkg/src/b.ts');
    expect(table.edgeCount).toBe(0);
    expect(table.symbolCount).toBe(1); // 'foo' still exists
  });

  it('noop on unknown file', () => {
    table.upsertFile('/pkg/src/a.ts', [sym('foo')]);
    table.removeFile('/pkg/src/unknown.ts');
    expect(table.symbolCount).toBe(1);
  });
});

describe('SymbolTable.getTransitiveCallers', () => {
  it('returns empty for unknown seed', () => {
    expect(table.getTransitiveCallers(['unknown'], 3)).toHaveLength(0);
  });

  it('returns direct callers at depth 1', () => {
    // baz calls foo
    table.upsertFile('/pkg/src/a.ts', [sym('foo')]);
    table.upsertFile('/pkg/src/b.ts', [sym('baz', '/pkg/src/b.ts')], {
      extractDeps: () => ['foo'],
    });

    const callers = table.getTransitiveCallers(['foo'], 1);
    expect(callers).toHaveLength(1);
    expect(callers[0].name).toBe('baz');
    expect(callers[0].depth).toBe(1);
  });

  it('returns callers at depth 2', () => {
    // qux → baz → foo  (depth 2 from foo)
    table.upsertFile('/pkg/src/a.ts', [sym('foo')]);
    table.upsertFile('/pkg/src/b.ts', [sym('baz', '/pkg/src/b.ts')], {
      extractDeps: () => ['foo'],
    });
    table.upsertFile('/pkg/src/c.ts', [sym('qux', '/pkg/src/c.ts')], {
      extractDeps: () => ['baz'],
    });

    const callers = table.getTransitiveCallers(['foo'], 2);
    const names = callers.map(r => r.name).sort();
    expect(names).toEqual(['baz', 'qux']);
    expect(callers.find(r => r.name === 'qux')!.depth).toBe(2);
  });

  it('depth 3 — three-hop chain', () => {
    // d → c → b → a
    table.upsertFile('/f/a.ts', [sym('a', '/f/a.ts')]);
    table.upsertFile('/f/b.ts', [sym('b', '/f/b.ts')], { extractDeps: () => ['a'] });
    table.upsertFile('/f/c.ts', [sym('c', '/f/c.ts')], { extractDeps: () => ['b'] });
    table.upsertFile('/f/d.ts', [sym('d', '/f/d.ts')], { extractDeps: () => ['c'] });

    const callers3 = table.getTransitiveCallers(['a'], 3);
    expect(callers3.map(r => r.name).sort()).toEqual(['b', 'c', 'd']);

    // depth 2 should stop at c
    const callers2 = table.getTransitiveCallers(['a'], 2);
    expect(callers2.map(r => r.name).sort()).toEqual(['b', 'c']);
  });

  it('excludes seed symbols from results', () => {
    table.upsertFile('/f/a.ts', [sym('a', '/f/a.ts')]);
    table.upsertFile('/f/b.ts', [sym('b', '/f/b.ts')], { extractDeps: () => ['a'] });

    const callers = table.getTransitiveCallers(['a'], 3);
    expect(callers.every(r => r.name !== 'a')).toBe(true);
  });

  it('returns empty when seeds exist but no one calls them', () => {
    table.upsertFile('/f/a.ts', [sym('a', '/f/a.ts')]);
    expect(table.getTransitiveCallers(['a'], 3)).toHaveLength(0);
  });

  it('handles multiple seeds', () => {
    table.upsertFile('/f/a.ts', [sym('a', '/f/a.ts')]);
    table.upsertFile('/f/b.ts', [sym('b', '/f/b.ts')]);
    table.upsertFile('/f/c.ts', [sym('c', '/f/c.ts')], { extractDeps: () => ['a'] });
    table.upsertFile('/f/d.ts', [sym('d', '/f/d.ts')], { extractDeps: () => ['b'] });

    const callers = table.getTransitiveCallers(['a', 'b'], 1);
    expect(callers.map(r => r.name).sort()).toEqual(['c', 'd']);
  });
});
