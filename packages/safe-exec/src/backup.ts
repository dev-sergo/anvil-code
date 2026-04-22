import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config, logger } from '@rag-system/shared';

// Filename format: <8-char-md5>-<timestamp><ext>
const NAME_RE = /^[a-f0-9]{8}-(\d+)\..+$/;

export class BackupManager {
  private backupsDir: string;

  constructor(backupsDir?: string) {
    this.backupsDir = path.resolve(backupsDir ?? config.safeExec.backupsPath);
  }

  backup(filePath: string): string | null {
    if (!config.safeExec.backup) return null;
    if (!fs.existsSync(filePath)) return null;

    fs.mkdirSync(this.backupsDir, { recursive: true });

    const hash = crypto.createHash('md5').update(filePath).digest('hex').slice(0, 8);
    const backupPath = path.join(this.backupsDir, `${hash}-${Date.now()}${path.extname(filePath)}`);
    fs.copyFileSync(filePath, backupPath);

    logger.debug({ original: filePath, backup: backupPath }, 'File backed up');
    return backupPath;
  }

  /**
   * Delete backup files whose embedded timestamp is older than `maxAgeMs`.
   * Returns the number of files removed.
   */
  prune(maxAgeMs: number = config.safeExec.backupMaxAgeMs, now: number = Date.now()): number {
    if (!fs.existsSync(this.backupsDir)) return 0;

    const cutoff = now - maxAgeMs;
    let removed = 0;

    for (const entry of fs.readdirSync(this.backupsDir)) {
      const m = NAME_RE.exec(entry);
      if (!m) continue;
      const ts = Number(m[1]);
      if (!Number.isFinite(ts) || ts >= cutoff) continue;
      try {
        fs.unlinkSync(path.join(this.backupsDir, entry));
        removed++;
      } catch (err: unknown) {
        logger.debug({ entry, error: String(err) }, 'Backup prune failed for entry');
      }
    }

    if (removed > 0) {
      logger.info({ removed, maxAgeMs }, 'Backup rotation: pruned old files');
    }
    return removed;
  }
}
