import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config, logger } from '@rag-system/shared';

export interface Project {
  id: string;
  name: string;
  root: string;          // absolute path
  createdAt: number;
  lastAccessedAt: number;
}

/**
 * Per-project storage paths. The id is hashed from the absolute root, so the
 * directory layout is stable across renames of the human-readable name.
 */
export interface ProjectPaths {
  base: string;
  memoryDb: string;
  vectorsDir: string;
  graphsDir: string;
  backupsDir: string;
}

export function deriveProjectId(absRoot: string): string {
  return crypto.createHash('sha1').update(path.resolve(absRoot)).digest('hex').slice(0, 12);
}

export function projectPaths(project: Project, dataRoot: string = config.dataRoot): ProjectPaths {
  const base = path.resolve(dataRoot, 'projects', project.id);
  return {
    base,
    memoryDb: path.join(base, 'memory.db'),
    vectorsDir: path.join(base, 'vectors'),
    graphsDir: path.join(base, 'graphs'),
    backupsDir: path.join(base, 'backups'),
  };
}

interface ProjectRow {
  id: string;
  name: string;
  root: string;
  created_at: number;
  last_accessed_at: number;
}

export class ProjectRegistry {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolved = path.resolve(dbPath ?? config.projects.registryPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.init();
    logger.debug({ dbPath: resolved }, 'ProjectRegistry initialized');
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL
      );
    `);
  }

  /**
   * Register a project at `absRoot`, or return the existing entry if one already
   * points at this path. Updates the human-readable name when given.
   */
  register(absRoot: string, name?: string): Project {
    const root = path.resolve(absRoot);
    const id = deriveProjectId(root);
    const now = Date.now();
    const displayName = name ?? path.basename(root);

    const existing = this.get(id);
    if (existing) {
      this.db.prepare(
        'UPDATE projects SET name = ?, last_accessed_at = ? WHERE id = ?',
      ).run(name ?? existing.name, now, id);
      return { ...existing, name: name ?? existing.name, lastAccessedAt: now };
    }

    this.db.prepare(`
      INSERT INTO projects (id, name, root, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, displayName, root, now, now);

    return { id, name: displayName, root, createdAt: now, lastAccessedAt: now };
  }

  get(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  getByRoot(absRoot: string): Project | undefined {
    return this.get(deriveProjectId(absRoot));
  }

  list(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY last_accessed_at DESC').all() as ProjectRow[];
    return rows.map(r => this.fromRow(r));
  }

  /** Bump lastAccessedAt — call this when a task targets the project. */
  touch(id: string): void {
    this.db.prepare('UPDATE projects SET last_accessed_at = ? WHERE id = ?').run(Date.now(), id);
  }

  /** Remove a project from the registry. Does NOT delete its data directory. */
  unregister(id: string): boolean {
    const result = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }

  private fromRow(row: ProjectRow): Project {
    return {
      id: row.id,
      name: row.name,
      root: row.root,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
    };
  }
}
