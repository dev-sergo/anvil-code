import Database from 'better-sqlite3';
import { config, logger } from '@rag-system/shared';
import path from 'path';
import fs from 'fs';
import type { TaskRecord, ADRRecord, FailureRecord } from './types.js';

export class MemoryStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolved = path.resolve(dbPath ?? config.memory.dbPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.init();
    logger.debug({ dbPath: resolved }, 'MemoryStore initialized');
  }

  private init(): void {
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
