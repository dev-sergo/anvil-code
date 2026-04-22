import { simpleGit, SimpleGit } from 'simple-git';
import { logger } from '@rag-system/shared';
import path from 'path';

export class GitEngine {
  private git: SimpleGit;
  private rootDir: string;

  constructor(rootDir: string = process.cwd()) {
    this.rootDir = path.resolve(rootDir);
    this.git = simpleGit({ baseDir: this.rootDir });
  }

  async verifyRepo(): Promise<boolean> {
    return this.git.checkIsRepo();
  }

  async createBranchForTask(taskId: string): Promise<string> {
    const branchName = `auto/task-${taskId}-${Date.now()}`;
    logger.info({ branchName }, 'Creating git branch');
    
    // Make sure we are on main/master first, or whichever default
    // We assume 'main' for now.
    try {
      await this.git.checkout('main');
    } catch {
       // fallback to master if main doesn't exist
       try { await this.git.checkout('master'); } catch (e) {
           logger.warn('Neither main nor master found. Staying on current branch.');
       }
    }

    try {
      await this.git.checkoutLocalBranch(branchName);
      return branchName;
    } catch (e: any) {
      logger.error({ error: e.message }, 'Failed to create branch');
      throw e;
    }
  }

  async commitChanges(taskId: string, message: string, files: string[]): Promise<string> {
    try {
      logger.debug({ files }, 'Staging files for commit');
      await this.git.add(files);
      const commitResult = await this.git.commit(`[Auto-${taskId}] ${message}`);
      
      logger.info({ commitHash: commitResult.commit }, 'Committed changes');
      return commitResult.commit;
    } catch (e: any) {
      logger.error({ error: e.message }, 'Failed to commit changes');
      throw e;
    }
  }

  async rollback(commitHash: string): Promise<void> {
    logger.warn({ commitHash }, 'Rolling back to commit');
    try {
      await this.git.revert(commitHash);
    } catch (e: any) {
      logger.error({ error: e.message }, 'Rollback failed');
      throw e;
    }
  }
}
