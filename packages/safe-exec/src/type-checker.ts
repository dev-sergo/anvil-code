import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '@rag-system/shared';
import type { ValidationResult } from './test-runner.js';

export class TypeChecker {
  constructor(
    private projectRoot: string,
    private timeoutMs: number = 120_000,
  ) {}

  async run(): Promise<ValidationResult> {
    const tsconfig = this.findTsconfig();
    if (!tsconfig) {
      return { success: true, output: '', exitCode: 0, durationMs: 0, skipped: 'no tsconfig.json' };
    }

    return this.spawnWithTimeout('npx', ['--no-install', 'tsc', '--noEmit', '-p', tsconfig]);
  }

  private findTsconfig(): string | null {
    // Check root, then common monorepo layout
    const rootCfg = path.join(this.projectRoot, 'tsconfig.json');
    if (fs.existsSync(rootCfg)) return rootCfg;
    const baseCfg = path.join(this.projectRoot, 'tsconfig.base.json');
    if (fs.existsSync(baseCfg)) return baseCfg;
    return null;
  }

  private spawnWithTimeout(command: string, args: string[]): Promise<ValidationResult> {
    const start = Date.now();
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
        output += `\n[TypeChecker] Killed after ${this.timeoutMs}ms timeout`;
      }, this.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - start;
        const exitCode = code ?? 1;
        const success = exitCode === 0;
        logger.info({ exitCode, durationMs, success }, 'TypeChecker finished');
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
