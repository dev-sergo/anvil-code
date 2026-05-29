import Database from 'better-sqlite3';
import crypto from 'crypto';
import { config, logger } from '@rag-system/shared';
import path from 'path';
import fs from 'fs';
import type { TaskRecord, ADRRecord, FailureRecord, RepoPatternRecord } from './types.js';
import { SymbolTable } from './symbol-table.js';

function normalizeIssue(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

function issueHash(issue: string): string {
  return crypto.createHash('sha256').update(normalizeIssue(issue)).digest('hex').slice(0, 16);
}

function rowToPattern(row: Record<string, unknown>, isLocal: boolean): RepoPatternRecord {
  return {
    id: row.id as string,
    issue: row.issue as string,
    projectId: (row.project_id as string | null) ?? '',
    hitCount: (row.hit_count as number | null) ?? 1,
    issueHash: (row.issue_hash as string | null) ?? undefined,
    isLocal,
    createdAt: (row.created_at as string | null) ?? undefined,
    lastSeen: (row.last_seen as string | null) ?? undefined,
  };
}

export class MemoryStore {
  private db: Database.Database;
  readonly symbolTable: SymbolTable;

  constructor(dbPath?: string) {
    const resolved = path.resolve(dbPath ?? config.memory.dbPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.init();
    this.symbolTable = new SymbolTable(this.db);
    logger.debug({ dbPath: resolved }, 'MemoryStore initialized');
  }

  private init(): void {
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        result TEXT,
        completed_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS adr (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        context TEXT NOT NULL,
        consequences TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern TEXT NOT NULL UNIQUE,
        count INTEGER NOT NULL DEFAULT 1,
        resolution TEXT,
        last_seen_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS file_hashes (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        indexed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS embedding_cache (
        cache_key TEXT PRIMARY KEY,
        vector TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repo_patterns (
        id TEXT PRIMARY KEY,
        issue TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );


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
    this.migrateRepoPatterns();
  }

  private migrateRepoPatterns(): void {
    const cols = (this.db.pragma('table_info(repo_patterns)') as Array<{ name: string }>).map(c => c.name);
    if (!cols.includes('project_id')) {
      this.db.exec(`ALTER TABLE repo_patterns ADD COLUMN project_id TEXT NOT NULL DEFAULT ''`);
    }
    if (!cols.includes('hit_count')) {
      this.db.exec(`ALTER TABLE repo_patterns ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 1`);
    }
    if (!cols.includes('issue_hash')) {
      this.db.exec(`ALTER TABLE repo_patterns ADD COLUMN issue_hash TEXT`);
    }
    if (!cols.includes('last_seen')) {
      this.db.exec(`ALTER TABLE repo_patterns ADD COLUMN last_seen TEXT`);
    }
    // Drop partial index if it exists (partial indexes don't support UPSERT ON CONFLICT target)
    this.db.exec(`DROP INDEX IF EXISTS repo_patterns_hash_idx`);
    // Regular UNIQUE INDEX: SQLite treats multiple NULLs as distinct, so old NULL rows coexist safely
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS repo_patterns_hash_idx
        ON repo_patterns(issue_hash)
    `);
  }

  saveTask(task: TaskRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO tasks (id, description, status, result, completed_at, created_at)
      VALUES (@id, @description, @status, @result, @completedAt, COALESCE(@createdAt, datetime('now')))
    `).run({
      id: task.id,
      description: task.description,
      status: task.status,
      result: task.result ?? null,
      completedAt: task.completedAt ?? null,
      createdAt: task.createdAt ?? null,
    });
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      description: row.description as string,
      status: row.status as TaskRecord['status'],
      result: (row.result as string | null) ?? undefined,
      completedAt: (row.completed_at as string | null) ?? undefined,
      createdAt: (row.created_at as string | null) ?? undefined,
    };
  }

  updateTaskStatus(id: string, status: TaskRecord['status'], result?: string): void {
    this.db.prepare(`
      UPDATE tasks
      SET status = ?,
          result = ?,
          completed_at = CASE WHEN ? IN ('completed','failed') THEN datetime('now') ELSE completed_at END
      WHERE id = ?
    `).run(status, result ?? null, status, id);
  }

  listTasks(limit = 50): TaskRecord[] {
    return (this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[])
      .map(row => ({
        id: row.id as string,
        description: row.description as string,
        status: row.status as TaskRecord['status'],
        result: (row.result as string | null) ?? undefined,
        completedAt: (row.completed_at as string | null) ?? undefined,
        createdAt: (row.created_at as string | null) ?? undefined,
      }));
  }

  saveADR(adr: ADRRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO adr (id, task_id, decision, context, consequences)
      VALUES (@id, @taskId, @decision, @context, @consequences)
    `).run({ id: adr.id, taskId: adr.taskId, decision: adr.decision, context: adr.context, consequences: adr.consequences });
  }

  listADR(limit = 20): ADRRecord[] {
    return (this.db.prepare('SELECT * FROM adr ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[])
      .map(row => ({
        id: row.id as string,
        taskId: row.task_id as string,
        decision: row.decision as string,
        context: row.context as string,
        consequences: row.consequences as string,
        createdAt: (row.created_at as string | null) ?? undefined,
      }));
  }

  saveFailure(pattern: string, resolution?: string): void {
    this.db.prepare(`
      INSERT INTO failures (pattern, count, resolution) VALUES (?, 1, ?)
      ON CONFLICT(pattern) DO UPDATE SET
        count = count + 1,
        last_seen_at = datetime('now'),
        resolution = COALESCE(excluded.resolution, resolution)
    `).run(pattern, resolution ?? null);
  }

  getFailurePatterns(limit = 10): FailureRecord[] {
    return this.db.prepare('SELECT * FROM failures ORDER BY count DESC LIMIT ?').all(limit) as FailureRecord[];
  }

  saveRepoPattern(projectId: string, issue: string): void {
    const hash = issueHash(issue);
    const id = `${hash}-${projectId}`;
    this.db.prepare(`
      INSERT INTO repo_patterns (id, issue, project_id, hit_count, issue_hash, last_seen)
      VALUES (?, ?, ?, 1, ?, datetime('now'))
      ON CONFLICT(issue_hash) DO UPDATE SET
        hit_count = hit_count + 1,
        last_seen  = datetime('now')
    `).run(id, issue.slice(0, 600), projectId, hash);
  }

  getRepoPatterns(limit = 5): RepoPatternRecord[] {
    return (this.db
      .prepare('SELECT * FROM repo_patterns ORDER BY hit_count DESC, last_seen DESC, created_at DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[])
      .map(row => rowToPattern(row, true));
  }

  static getCrossProjectPatterns(
    currentProjectId: string,
    registryDbPath: string,
    dataRoot: string,
    limit = 5,
  ): RepoPatternRecord[] {
    let projectIds: string[] = [];
    try {
      const reg = new Database(path.resolve(registryDbPath), { readonly: true });
      projectIds = (reg.prepare('SELECT id FROM projects').all() as Array<{ id: string }>)
        .map(r => r.id)
        .filter(id => id !== currentProjectId);
      reg.close();
    } catch {
      return [];
    }

    const merged = new Map<string, RepoPatternRecord>();
    for (const pid of projectIds) {
      const dbPath = path.resolve(dataRoot, 'projects', pid, 'memory.db');
      if (!fs.existsSync(dbPath)) continue;
      try {
        const db = new Database(dbPath, { readonly: true });
        const rows = db
          .prepare(
            `SELECT * FROM repo_patterns WHERE issue_hash IS NOT NULL
             ORDER BY hit_count DESC LIMIT ?`,
          )
          .all(limit) as Record<string, unknown>[];
        db.close();
        for (const row of rows) {
          const hash = row.issue_hash as string;
          const existing = merged.get(hash);
          const hitCount = (row.hit_count as number | null) ?? 1;
          if (existing) {
            existing.hitCount += hitCount;
          } else {
            merged.set(hash, { ...rowToPattern(row, false), hitCount });
          }
        }
      } catch {
        // skip unreadable / old-schema DBs
      }
    }

    return [...merged.values()]
      .sort((a, b) => b.hitCount - a.hitCount)
      .slice(0, limit);
  }

  getFileHash(filePath: string): string | undefined {
    const row = this.db.prepare('SELECT hash FROM file_hashes WHERE path = ?').get(filePath) as { hash: string } | undefined;
    return row?.hash;
  }

  saveFileHash(filePath: string, hash: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO file_hashes (path, hash, indexed_at) VALUES (?, ?, ?)
    `).run(filePath, hash, Date.now());
  }

  deleteFileHash(filePath: string): void {
    this.db.prepare('DELETE FROM file_hashes WHERE path = ?').run(filePath);
  }

  getCachedEmbedding(cacheKey: string): number[] | undefined {
    const row = this.db.prepare('SELECT vector FROM embedding_cache WHERE cache_key = ?').get(cacheKey) as { vector: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.vector) as number[];
    } catch {
      return undefined;
    }
  }

  saveCachedEmbedding(cacheKey: string, vector: number[]): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO embedding_cache (cache_key, vector, created_at) VALUES (?, ?, ?)
    `).run(cacheKey, JSON.stringify(vector), Date.now());
  }

  close(): void {
    this.db.close();
  }
}
