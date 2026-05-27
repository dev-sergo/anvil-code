/**
 * v1.67 — One-shot migration: load CodeGraph JSON → populate SQLite symbols/dependencies.
 *
 * Usage:
 *   npx tsx packages/rag/src/scripts/migrate-graph-to-sqlite.ts
 *
 * Idempotent: uses INSERT OR IGNORE — safe to re-run.
 * The script walks all project directories under data/projects/ and migrates
 * each graph.json it finds.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { ASTParser } from '@rag-system/code-graph';
import type { CodeSymbol } from '@rag-system/code-graph';
import { SymbolTable } from '@rag-system/memory';
import { extractPackageName } from '../graph-retriever.js';

interface GraphData {
  symbols: Record<string, CodeSymbol[]>;
  savedAt?: string;
}

function migrateGraph(graphPath: string, db: Database.Database): { symbols: number; edges: number } {
  let data: GraphData;
  try {
    data = JSON.parse(fs.readFileSync(graphPath, 'utf8')) as GraphData;
  } catch (err) {
    console.error(`  Failed to parse ${graphPath}: ${String(err)}`);
    return { symbols: 0, edges: 0 };
  }

  const parser = new ASTParser();
  const table = new SymbolTable(db);

  let symbolsTotal = 0;
  let edgesTotal = 0;

  for (const [filePath, syms] of Object.entries(data.symbols)) {
    if (!Array.isArray(syms) || syms.length === 0) continue;

    const pkgName = extractPackageName(filePath);
    table.upsertFile(filePath, syms, {
      packageName: pkgName,
      extractDeps: (sym) => parser.extractDependencies(sym),
    });

    symbolsTotal += syms.length;
  }

  edgesTotal = table.edgeCount;

  return { symbols: symbolsTotal, edges: edgesTotal };
}

function findProjectDirs(dataRoot: string): string[] {
  const projectsDir = path.join(dataRoot, 'projects');
  if (!fs.existsSync(projectsDir)) return [];
  return fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(projectsDir, d.name));
}

async function main(): Promise<void> {
  const dataRoot = path.resolve(process.env['DATA_ROOT'] ?? 'data');
  const projectDirs = findProjectDirs(dataRoot);

  if (projectDirs.length === 0) {
    console.log(`No project directories found under ${dataRoot}/projects — nothing to migrate.`);
    return;
  }

  console.log(`Found ${projectDirs.length} project(s) under ${dataRoot}/projects`);

  for (const projectDir of projectDirs) {
    const graphPath = path.join(projectDir, 'graphs', 'graph.json');
    const dbPath = path.join(projectDir, 'memory.db');

    if (!fs.existsSync(graphPath)) {
      console.log(`  [skip] ${path.basename(projectDir)} — no graph.json`);
      continue;
    }
    if (!fs.existsSync(dbPath)) {
      console.log(`  [skip] ${path.basename(projectDir)} — no memory.db`);
      continue;
    }

    console.log(`\nMigrating project: ${path.basename(projectDir)}`);
    console.log(`  graph: ${graphPath}`);
    console.log(`  db:    ${dbPath}`);

    const db = new Database(dbPath);
    db.exec('PRAGMA foreign_keys = ON');

    // Ensure tables exist (idempotent DDL)
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

    const before = (db.prepare('SELECT COUNT(*) as n FROM symbols').get() as { n: number }).n;
    const { symbols, edges } = migrateGraph(graphPath, db);
    const after = (db.prepare('SELECT COUNT(*) as n FROM symbols').get() as { n: number }).n;

    db.close();

    console.log(`  symbols in graph.json: ${symbols}`);
    console.log(`  symbols before: ${before}  after: ${after}  (new: ${after - before})`);
    console.log(`  total edges: ${edges}`);
  }

  console.log('\nMigration complete.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
