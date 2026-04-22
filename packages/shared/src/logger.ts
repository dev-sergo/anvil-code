import pino, { type Logger } from 'pino';

const isDev = process.env.NODE_ENV !== 'production';
const level = process.env.LOG_LEVEL ?? 'info';

export const logger = pino(
  { level },
  isDev
    ? pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      })
    : undefined
);

/**
 * Create a child logger that auto-attaches `taskId` to every log line.
 * Use inside per-task scopes (orchestrator, worker) so logs can be filtered
 * by task without callers having to pass taskId on every call.
 */
export function taskLogger(taskId: string): Logger {
  return logger.child({ taskId });
}
