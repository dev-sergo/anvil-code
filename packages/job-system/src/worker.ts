import { config, logger, taskEvents, taskLogger } from '@rag-system/shared';
import type { TaskMode } from '@rag-system/shared';
import type { MemoryStore } from '@rag-system/memory';
import { MemoryQueue } from './queue.js';

interface TaskRunner {
  runTask(id: string, description: string, mode: TaskMode): Promise<void>;
}

export class JobWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private processing = false;

  constructor(
    private queue: MemoryQueue,
    private orchestrator: TaskRunner,
    private store: MemoryStore
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('JobWorker started');

    this.timer = setInterval(() => { void this.tick(); }, config.jobs.pollIntervalMs);

    const shutdown = () => {
      this.stop();
      process.exit(0);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    logger.info('JobWorker stopped');
  }

  private async tick(): Promise<void> {
    if (this.processing) return;
    const job = this.queue.dequeue();
    if (!job) return;

    this.processing = true;
    const log = taskLogger(job.id);
    log.info('Processing job');
    this.store.updateTaskStatus(job.id, 'running');
    taskEvents.emitEvent({ taskId: job.id, type: 'running', message: 'Job started' });

    try {
      await this.orchestrator.runTask(job.id, job.description, job.mode);
      this.queue.updateStatus(job.id, 'completed');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ error: message }, 'Job failed');
      this.queue.updateStatus(job.id, 'failed', message);
      this.store.updateTaskStatus(job.id, 'failed', message);
      taskEvents.emitEvent({ taskId: job.id, type: 'error', message });
    } finally {
      this.processing = false;
    }
  }
}
