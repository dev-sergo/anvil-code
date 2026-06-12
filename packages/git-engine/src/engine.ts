import { simpleGit, SimpleGit } from 'simple-git';
import { logger, config } from '@rag-system/shared';
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

  private async branchExists(name: string): Promise<boolean> {
    const result = await this.git.branch(['--list', name]);
    return result.all.includes(name);
  }

  // v1.39-a — resolve where a new task branch should fork from. In cumulative
  // mode that's `auto/cumulative` (created on first use from defaultBranch);
  // otherwise it's defaultBranch unchanged.
  private async resolveBaseBranch(): Promise<string> {
    const defaultBranch = config.git.defaultBranch;
    if (!config.git.cumulative.enabled) return defaultBranch;

    const cumulative = config.git.cumulative.branch;
    if (await this.branchExists(cumulative)) return cumulative;

    await this.git.checkout(defaultBranch);
    await this.git.checkoutLocalBranch(cumulative);
    logger.info({ cumulative, from: defaultBranch }, 'Created cumulative branch');
    return cumulative;
  }

  async createBranchForTask(taskId: string): Promise<string> {
    const branchName = `auto/task-${taskId}-${Date.now()}`;
    logger.info({ branchName }, 'Creating git branch');

    const base = await this.resolveBaseBranch();

    // Discard any uncommitted tracked changes and untracked files left over from a
    // previous commit_skipped task. Without this, tasks that fail validation leave
    // dirty state in the working tree which pollutes subsequent tasks' baseline.
    try {
      await this.git.checkout(['-f', base]);
    } catch {
      const fallback = base === 'main' ? 'master' : 'main';
      try { await this.git.checkout(['-f', fallback]); } catch {
        logger.warn({ base }, 'Base branch not found. Staying on current branch.');
      }
    }
    try {
      await this.git.clean('f', ['-d']);
    } catch (e: any) {
      logger.warn({ error: e.message }, 'git clean failed — continuing anyway');
    }

    try {
      await this.git.checkoutLocalBranch(branchName);
      return branchName;
    } catch (e: any) {
      logger.error({ error: e.message }, 'Failed to create branch');
      throw e;
    }
  }

  // v1.39-a — fast-forward merge a finished task branch into the cumulative
  // branch. Caller (orchestrator) invokes this only when CUMULATIVE_MODE is on
  // and the commit succeeded. Throws on any non-ff scenario so the task is
  // marked failed and the branch is retained for manual review.
  async mergeIntoCumulative(taskBranch: string): Promise<void> {
    const cumulative = config.git.cumulative.branch;
    logger.info({ taskBranch, cumulative }, 'Fast-forward merging task branch into cumulative');
    await this.git.checkout(cumulative);
    try {
      await this.git.merge(['--ff-only', taskBranch]);
    } catch (e: any) {
      logger.warn({ taskBranch, error: e.message }, 'Cumulative ff-merge failed');
      throw new Error(`Cumulative ff-merge of ${taskBranch} failed: ${e.message}`);
    }
  }

  /**
   * v1.71 — Return every path that differs from HEAD in the working tree:
   * modified/created/deleted tracked files plus untracked files (respecting
   * .gitignore). `git status` reports each changed file exactly once with
   * repo-root-relative paths, matching the project-relative paths the
   * orchestrator tracks in `writtenFiles`.
   *
   * Used as a commit-completeness safety net (H6 bug): a tool-calling agent can
   * write a file to disk but omit it from its stated file list, leaving it
   * untracked. Staging only the stated list left such files behind, and the
   * next task's `git clean -fd` deleted them. Because each task branch is
   * forked from a freshly-cleaned base, anything reported here is task output.
   */
  async listWorkingChanges(): Promise<string[]> {
    const status = await this.git.status();
    return status.files.map(f => f.path);
  }

  async commitChanges(taskId: string, message: string, files: string[]): Promise<string> {
    logger.debug({ files }, 'Staging files for commit');
    await this.git.add(files);
    try {
      const commitResult = await this.git.commit(`[Auto-${taskId}] ${message}`);
      logger.info({ commitHash: commitResult.commit }, 'Committed changes');
      return commitResult.commit;
    } catch (e: any) {
      // Pre-commit hooks (e.g. lint-staged + prettier/oxfmt) may reformat staged
      // files and leave them unstaged, causing the commit to fail. Detect this by
      // checking for modified tracked files after the failure, then re-stage and
      // retry once so the formatted version is what gets committed.
      logger.warn({ error: e.message }, 'Commit failed — checking for hook-reformatted files');
      let modified: string[] = [];
      try {
        const status = await this.git.status();
        modified = status.modified;
      } catch {
        // status failed — rethrow original error
        logger.error({ error: e.message }, 'Failed to commit changes');
        throw e;
      }
      if (modified.length === 0) {
        logger.error({ error: e.message }, 'Failed to commit changes');
        throw e;
      }
      logger.info({ modified }, 'Pre-commit hook reformatted files — re-staging and retrying');
      try {
        await this.git.add(files);
        const commitResult = await this.git.commit(`[Auto-${taskId}] ${message}`);
        logger.info({ commitHash: commitResult.commit }, 'Committed changes (after hook re-stage)');
        return commitResult.commit;
      } catch (retryErr: any) {
        logger.error({ error: retryErr.message }, 'Commit retry also failed after hook re-stage');
        throw retryErr;
      }
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
