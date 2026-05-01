import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '@rag-system/shared';

export interface PrettierResult {
  /**
   * `true` if prettier ran successfully OR if it was skipped (no config found).
   * `false` only if prettier crashed mid-run — caller should NOT fail the
   * commit on `false`, just log; cosmetics never block correctness.
   */
  success: boolean;
  /** Files that prettier touched. Empty when skipped. */
  formatted: string[];
  /** Why we skipped, if applicable. */
  skipped?: string;
  /** Last ~4KB of stdout/stderr. */
  output: string;
  durationMs: number;
}

/**
 * Detect whether the target project has prettier configured. We check the
 * cheap signals first (config files, then `prettier` field in package.json,
 * then dep listings) and short-circuit on any hit.
 *
 * Why this matters: running prettier without project config falls back to
 * prettier defaults, which would *change* code style on projects that
 * intentionally don't use prettier — exactly the opposite of "minimize diff
 * noise". So we run only when the project has explicitly opted in.
 */
const PRETTIER_CONFIG_FILES = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
];

export function isPrettierConfigured(projectRoot: string): boolean {
  // Config file present — strongest signal.
  for (const f of PRETTIER_CONFIG_FILES) {
    if (fs.existsSync(path.join(projectRoot, f))) return true;
  }
  // package.json signals: top-level "prettier" field, or prettier in deps.
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      prettier?: unknown;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (pkg.prettier !== undefined) return true;
    if (pkg.dependencies?.prettier) return true;
    if (pkg.devDependencies?.prettier) return true;
  } catch {
    // Invalid package.json — treat as not configured rather than throwing.
  }
  return false;
}

/**
 * v1.32-a.6 — runs `prettier --write` on the files Coder/Fixer produced,
 * after validation passes and before commit. Goal: collapse cosmetic style
 * variance (indent depth, trailing commas, blank lines) so diffs become
 * byte-perfect.
 *
 * Hard requirement: never fail a commit because of prettier. Validation
 * passing is the contract; cosmetics are best-effort. This runner's
 * `success` is `true` even when nothing ran (skipped) — `false` only on
 * actual prettier crashes, which the orchestrator logs but ignores.
 */
export class PrettierRunner {
  constructor(
    private projectRoot: string,
    private timeoutMs: number = 30_000,
  ) {}

  /**
   * Run prettier on the given files (project-relative paths). No-op when:
   *   - paths is empty
   *   - prettier is not configured in the target project
   *   - the local prettier binary doesn't exist (we don't auto-install)
   */
  async run(paths: string[]): Promise<PrettierResult> {
    const start = Date.now();
    if (paths.length === 0) {
      return { success: true, formatted: [], output: '', durationMs: 0, skipped: 'no files' };
    }
    if (!isPrettierConfigured(this.projectRoot)) {
      return { success: true, formatted: [], output: '', durationMs: 0, skipped: 'no prettier config' };
    }

    // Filter to files that exist and have prettier-formattable extensions.
    // Prettier WILL try to format unknown extensions and fail — pre-filtering
    // keeps the output clean and avoids noisy errors on assets/binaries.
    const FORMATTABLE = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|md|html|css|scss|vue|svelte)$/;
    const candidates = paths.filter(p => {
      if (!FORMATTABLE.test(p)) return false;
      try {
        return fs.statSync(path.resolve(this.projectRoot, p)).isFile();
      } catch {
        return false;
      }
    });
    if (candidates.length === 0) {
      return {
        success: true,
        formatted: [],
        output: '',
        durationMs: Date.now() - start,
        skipped: 'no formattable files',
      };
    }

    const localBin = path.join(this.projectRoot, 'node_modules', '.bin', 'prettier');
    if (!fs.existsSync(localBin)) {
      // We deliberately don't fall back to global prettier or `npx --yes` —
      // that would silently install a version that may differ from the
      // project's pinned one and reformat with surprise rules.
      return {
        success: true,
        formatted: [],
        output: '',
        durationMs: Date.now() - start,
        skipped: 'prettier not installed in target project',
      };
    }

    const result = await this.spawn(localBin, ['--write', '--log-level', 'warn', ...candidates]);
    const durationMs = Date.now() - start;
    if (!result.success) {
      logger.warn(
        { exitCode: result.exitCode, output: result.output.slice(-500) },
        'Prettier exited non-zero; commit proceeds (cosmetics are best-effort)',
      );
      return { success: false, formatted: [], output: result.output, durationMs };
    }

    logger.info(
      { count: candidates.length, durationMs },
      'Prettier formatted post-validation files',
    );
    return { success: true, formatted: candidates, output: result.output, durationMs };
  }

  private spawn(command: string, args: string[]): Promise<{ success: boolean; output: string; exitCode: number }> {
    return new Promise((resolve) => {
      const proc = spawn(command, args, {
        cwd: this.projectRoot,
        env: { ...process.env, NO_COLOR: '1' },
      });

      let output = '';
      const append = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > 16_384) output = output.slice(-16_384);
      };
      proc.stdout?.on('data', append);
      proc.stderr?.on('data', append);

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        output += `\n[PrettierRunner] Killed after ${this.timeoutMs}ms timeout`;
      }, this.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        const exitCode = code ?? 1;
        resolve({ success: exitCode === 0, output: output.slice(-4000), exitCode });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          output: `Failed to spawn prettier: ${err.message}`,
          exitCode: 1,
        });
      });
    });
  }
}
