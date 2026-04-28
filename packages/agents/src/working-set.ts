import fs from 'fs';
import path from 'path';
import type { FileChange } from '@rag-system/shared';

/**
 * In-memory snapshot of the file system during a tool-calling Coder loop.
 *
 * The model's tool calls (read_file / replace_in_file / create_file /
 * delete_file) operate on a WorkingSet rather than touching disk directly.
 * `read` is lazy: a file is loaded from disk on first access and cached.
 * Subsequent reads inside the same loop see the in-memory mutations from
 * earlier replace/create calls. After the loop, `toFileChanges()` produces
 * the FileChange[] array consumed by the Orchestrator's existing write +
 * validation pipeline (SafeWriter, retry-with-feedback, validation Fixer).
 *
 * Why coordinate-based mutations are safe even without v1.23's patch format:
 * each `replace` only rewrites a line range the model explicitly named, with
 * actual disk content as the base. The model can't "hallucinate a search
 * block" because there is no search — only path + line range + new text.
 */

interface FileState {
  content: string;
  action: 'untouched' | 'modify' | 'create' | 'delete';
}

export type WorkingSetResult<T = void> =
  | (T extends void ? { ok: true } : { ok: true; value: T })
  | { ok: false; error: string };

export class WorkingSet {
  private files = new Map<string, FileState>();
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  /**
   * Returns current in-loop content (or `null` if file doesn't exist or was
   * deleted). On first access, lazily loads from disk and tracks as
   * 'untouched'. Subsequent reads return the latest mutated version.
   */
  read(relPath: string): string | null {
    const cached = this.files.get(relPath);
    if (cached !== undefined) {
      return cached.action === 'delete' ? null : cached.content;
    }
    try {
      const content = fs.readFileSync(this.absPath(relPath), 'utf8');
      this.files.set(relPath, { content, action: 'untouched' });
      return content;
    } catch {
      return null;
    }
  }

  exists(relPath: string): boolean {
    return this.read(relPath) !== null;
  }

  /**
   * Replace lines `[startLine..endLine]` (1-indexed, inclusive) with `newText`.
   * Empty `newText` deletes the line range entirely.
   *
   * `newText` may contain its own newlines — they're inserted literally.
   * Final result preserves existing line endings (we split on `\n`, so files
   * with `\r\n` lose the `\r` — acceptable on a Unix-first project, but a
   * caller that cares about CRLF should normalize before/after).
   */
  replace(relPath: string, startLine: number, endLine: number, newText: string): WorkingSetResult {
    const content = this.read(relPath);
    if (content === null) {
      return { ok: false, error: `file does not exist: ${relPath}` };
    }
    const lines = content.split('\n');
    if (startLine < 1) {
      return { ok: false, error: `start_line must be >= 1, got ${startLine}` };
    }
    if (endLine < startLine) {
      return { ok: false, error: `end_line (${endLine}) must be >= start_line (${startLine})` };
    }
    if (endLine > lines.length) {
      return {
        ok: false,
        error: `end_line ${endLine} out of range (file has ${lines.length} lines): ${relPath}`,
      };
    }

    const before = lines.slice(0, startLine - 1);
    const after = lines.slice(endLine);
    const insert = newText === '' ? [] : newText.split('\n');
    const merged = [...before, ...insert, ...after].join('\n');

    const prev = this.files.get(relPath)!;
    this.files.set(relPath, {
      content: merged,
      // A file created in this same loop stays 'create'; otherwise it's a modify.
      action: prev.action === 'create' ? 'create' : 'modify',
    });
    return { ok: true };
  }

  create(relPath: string, content: string): WorkingSetResult {
    if (this.exists(relPath)) {
      return { ok: false, error: `file already exists: ${relPath}` };
    }
    this.files.set(relPath, { content, action: 'create' });
    return { ok: true };
  }

  delete(relPath: string): WorkingSetResult {
    if (!this.exists(relPath)) {
      return { ok: false, error: `file does not exist: ${relPath}` };
    }
    this.files.set(relPath, { content: '', action: 'delete' });
    return { ok: true };
  }

  /**
   * Produce FileChange[] for the Orchestrator's write phase. Untouched files
   * are excluded. Both 'create' and 'modify' end up as `action: 'create'` with
   * full content — SafeWriter's "overwrite on create" path handles modifications
   * cleanly (a backup is taken first), and tool-calling Coder doesn't emit
   * search/replace blocks so the patch-based modify path doesn't apply here.
   */
  toFileChanges(): FileChange[] {
    const changes: FileChange[] = [];
    for (const [relPath, state] of this.files) {
      if (state.action === 'untouched') continue;
      if (state.action === 'delete') {
        changes.push({ action: 'delete', path: relPath });
      } else {
        changes.push({ action: 'create', path: relPath, content: state.content });
      }
    }
    return changes;
  }

  /**
   * Returns whether anything in the working set has been mutated. Useful for
   * detecting "model called done() without doing anything" cases.
   */
  hasChanges(): boolean {
    for (const state of this.files.values()) {
      if (state.action !== 'untouched') return true;
    }
    return false;
  }

  private absPath(relPath: string): string {
    return path.join(this.projectRoot, relPath);
  }
}
