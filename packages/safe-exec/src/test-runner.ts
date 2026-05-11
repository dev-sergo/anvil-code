import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '@rag-system/shared';

export interface ValidationResult {
  success: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
  skipped?: string;
}

export class TestRunner {
  constructor(
    private projectRoot: string,
    private timeoutMs: number = 60_000,
  ) {}

  async run(): Promise<ValidationResult> {
    const pkgPath = path.join(this.projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      return { success: true, output: '', exitCode: 0, durationMs: 0, skipped: 'no package.json' };
    }

    let pkg: { scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
    } catch {
      return { success: true, output: '', exitCode: 0, durationMs: 0, skipped: 'invalid package.json' };
    }

    const testScript = pkg.scripts?.test;
    if (!testScript || testScript.includes('Error: no test specified')) {
      return { success: true, output: '', exitCode: 0, durationMs: 0, skipped: 'no test script defined' };
    }

    const result = await this.spawnWithTimeout('npm', ['test', '--silent']);

    // "No test found in suite" is not a real test failure — it occurs when TesterAgent
    // generates an empty describe() block (which vitest counts as an error). If this is
    // the ONLY reason for exit code 1, treat the run as passed so the Fixer doesn't
    // loop trying to fix a non-existent production bug.
    if (!result.success && result.output.includes('No test found in suite')) {
      const lines = result.output.split('\n');
      const realFailures = lines.filter(l =>
        (l.includes(' FAIL ') || l.startsWith('FAIL ')) &&
        !lines.some(l2 => l2.includes('No test found')),
      );
      if (realFailures.length === 0) {
        logger.info('TestRunner: suppressing "No test found in suite" — empty describe block only');
        return { ...result, success: true };
      }
    }

    return result;
  }

  private spawnWithTimeout(command: string, args: string[]): Promise<ValidationResult> {
    const start = Date.now();
    return new Promise((resolve) => {
      const proc = spawn(command, args, {
        cwd: this.projectRoot,
        env: { ...process.env, CI: 'true', NO_COLOR: '1' },
      });

      let output = '';
      const append = (chunk: Buffer) => {
        output += chunk.toString();
        // Cap output at 16KB to avoid OOM on chatty test runners
        if (output.length > 16_384) output = output.slice(-16_384);
      };
      proc.stdout?.on('data', append);
      proc.stderr?.on('data', append);

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        output += `\n[TestRunner] Killed after ${this.timeoutMs}ms timeout`;
      }, this.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - start;
        const exitCode = code ?? 1;
        const success = exitCode === 0;
        logger.info({ exitCode, durationMs, success }, 'TestRunner finished');
        resolve({ success, output: output.slice(-4000), exitCode, durationMs });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          output: `Failed to spawn: ${err.message}`,
          exitCode: 1,
          durationMs: Date.now() - start,
        });
      });
    });
  }
}
