import fs from 'fs';
import path from 'path';
import { config, logger } from '@rag-system/shared';
import type { FileChange } from '@rag-system/shared';
import { BackupManager } from './backup.js';
import { DiffEngine } from './diff-engine.js';

export class SafeWriter {
  private backup: BackupManager;
  private diff: DiffEngine;
  private projectRoot: string;

  constructor(projectRoot?: string) {
    this.projectRoot = path.resolve(projectRoot ?? config.projectRoot);
    this.backup = new BackupManager();
    this.diff = new DiffEngine();
  }

  execute(change: FileChange): void {
    const resolved = this.resolveSafe(change.path);

    if (config.safeExec.dryRun) {
      logger.info({ path: change.path, action: change.action }, '[DRY-RUN] Would apply change');
      return;
    }

    if (change.action === 'delete') {
      this.backup.backup(resolved);
      if (fs.existsSync(resolved)) {
        fs.unlinkSync(resolved);
        logger.info({ path: change.path }, 'File deleted');
      }
      return;
    }

    const original = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : '';
    this.backup.backup(resolved);

    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, change.content, 'utf8');

    const result = this.diff.generate(original, change.content, change.path);
    const changedLines = (result.diff.match(/^[+-]/gm) ?? []).length;
    logger.info({ path: change.path, action: change.action, changedLines }, 'File written');
  }

  private resolveSafe(filePath: string): string {
    const resolved = path.resolve(this.projectRoot, filePath);
    if (!resolved.startsWith(this.projectRoot + path.sep) && resolved !== this.projectRoot) {
      throw new Error(`Path traversal attempt blocked: ${filePath}`);
    }
    return resolved;
  }
}
