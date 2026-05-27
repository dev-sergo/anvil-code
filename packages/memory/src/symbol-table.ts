import type Database from 'better-sqlite3';
import type { CodeSymbol } from '@rag-system/code-graph';

export interface SymbolRow {
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  body: string | null;
  packageName: string | null;
  depth: number;
}

export class SymbolTable {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // Replace all symbols for a file and rebuild their dependency edges.
  // extractDeps: receives a CodeSymbol, returns names of symbols it references.
  upsertFile(
    filePath: string,
    symbols: CodeSymbol[],
    opts: { packageName?: string; extractDeps?: (sym: CodeSymbol) => string[] } = {},
  ): void {
    this.db.transaction(() => {
      // Remove old symbols for this file (CASCADE removes their edges).
      this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(filePath);

      if (symbols.length === 0) return;

      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO symbols (name, kind, file_path, start_line, end_line, body, package_name)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const sym of symbols) {
        insert.run(
          sym.name,
          sym.kind,
          sym.filePath,
          sym.startLine,
          sym.endLine,
          sym.text ?? null,
          opts.packageName ?? null,
        );
      }

      if (!opts.extractDeps) return;

      // Build name→id map for the symbols we just inserted (from this file).
      const nameToId = new Map<string, number>();
      const rows = this.db.prepare(
        'SELECT id, name FROM symbols WHERE file_path = ?',
      ).all(filePath) as Array<{ id: number; name: string }>;
      for (const row of rows) nameToId.set(row.name, row.id);

      const insertEdge = this.db.prepare(`
        INSERT OR IGNORE INTO dependencies (from_id, to_id) VALUES (?, ?)
      `);

      for (const sym of symbols) {
        const fromId = nameToId.get(sym.name);
        if (fromId === undefined) continue;

        const depNames = opts.extractDeps(sym);
        for (const depName of depNames) {
          // Look up the dependency in the whole DB (may be in a different file).
          const toRow = this.db.prepare(
            'SELECT id FROM symbols WHERE name = ? LIMIT 1',
          ).get(depName) as { id: number } | undefined;
          if (!toRow || toRow.id === fromId) continue;
          insertEdge.run(fromId, toRow.id);
        }
      }
    })();
  }

  removeFile(filePath: string): void {
    this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(filePath);
  }

  // Recursive CTE: find all symbols that transitively reference any seed name,
  // up to maxDepth hops. Returns results ordered by ascending depth.
  getTransitiveCallers(
    seedNames: string[],
    maxDepth: number,
    limit = 200,
  ): SymbolRow[] {
    if (seedNames.length === 0) return [];

    // Resolve seed names → ids
    const placeholders = seedNames.map(() => '?').join(',');
    const seedRows = this.db.prepare(
      `SELECT id FROM symbols WHERE name IN (${placeholders})`,
    ).all(...seedNames) as Array<{ id: number }>;

    if (seedRows.length === 0) return [];
    const seedIds = seedRows.map(r => r.id);
    const seedPlaceholders = seedIds.map(() => '?').join(',');

    const rows = this.db.prepare(`
      WITH RECURSIVE callers(id, depth) AS (
        SELECT from_id, 1
        FROM   dependencies
        WHERE  to_id IN (${seedPlaceholders})

        UNION ALL

        SELECT d.from_id, c.depth + 1
        FROM   dependencies d
        JOIN   callers c ON d.to_id = c.id
        WHERE  c.depth < ?
      )
      SELECT DISTINCT
        s.name, s.kind, s.file_path, s.start_line, s.end_line, s.body, s.package_name,
        MIN(c.depth) AS depth
      FROM   callers c
      JOIN   symbols s ON s.id = c.id
      WHERE  s.id NOT IN (${seedPlaceholders})
      GROUP  BY s.id
      ORDER  BY depth, s.name
      LIMIT  ?
    `).all(...seedIds, maxDepth, ...seedIds, limit) as Array<{
      name: string;
      kind: string;
      file_path: string;
      start_line: number;
      end_line: number;
      body: string | null;
      package_name: string | null;
      depth: number;
    }>;

    return rows.map(r => ({
      name: r.name,
      kind: r.kind,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      body: r.body,
      packageName: r.package_name,
      depth: r.depth,
    }));
  }

  get symbolCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as n FROM symbols').get() as { n: number };
    return row.n;
  }

  get edgeCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as n FROM dependencies').get() as { n: number };
    return row.n;
  }
}
