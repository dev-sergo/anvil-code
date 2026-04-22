import { config, logger, validateConfig } from '@rag-system/shared';
import { OllamaClient, ModelRouter } from '@rag-system/model-router';
import { MemoryStore } from '@rag-system/memory';
import { SafeWriter, BackupManager } from '@rag-system/safe-exec';
import { GitEngine } from '@rag-system/git-engine';
import { GraphRetriever, FileWatcher } from '@rag-system/rag';
import { Orchestrator } from '@rag-system/agents';
import { MemoryQueue, JobWorker } from '@rag-system/job-system';
import { buildServer } from './server.js';

async function main() {
  validateConfig();

  const ollamaClient = new OllamaClient();
  const isOllamaUp = await ollamaClient.healthCheck();

  if (!isOllamaUp) {
    logger.warn(
      { url: config.ollama.baseUrl },
      'Ollama not available — tasks will fail until Ollama is running'
    );
  } else {
    logger.info({ url: config.ollama.baseUrl }, 'Ollama connected');
  }

  const store = new MemoryStore();
  const router = new ModelRouter(ollamaClient);
  const retriever = new GraphRetriever(store);
  const writer = new SafeWriter(config.projectRoot);
  const git = new GitEngine(config.projectRoot);

  await retriever.loadFromDisk();

  const orchestrator = new Orchestrator(router, retriever, writer, store, git);
  const queue = new MemoryQueue();
  const worker = new JobWorker(queue, orchestrator, store);

  worker.start();

  let watcher: FileWatcher | null = null;
  if (config.watcher.enabled) {
    watcher = new FileWatcher(retriever);
    watcher.start();
  }

  // Backup rotation: prune at startup, then on a long interval
  const backups = new BackupManager();
  backups.prune();
  const pruneTimer = setInterval(() => backups.prune(), config.safeExec.backupPruneIntervalMs);
  pruneTimer.unref();

  const server = buildServer(queue, store);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    clearInterval(pruneTimer);
    worker.stop();
    if (watcher) await watcher.stop();
    store.close();
    await server.close();
    process.exit(0);
  };

  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });

  try {
    await server.listen({ port: config.api.port, host: config.api.host });
    logger.info(`RAG System API running on http://${config.api.host}:${config.api.port}`);
    logger.info('Endpoints: POST /task  GET /task/:id  GET /tasks  GET /health');
  } catch (err) {
    logger.error(err, 'Failed to start API server');
    process.exit(1);
  }
}

main().catch(err => {
  logger.error(err, 'Fatal error');
  process.exit(1);
});
