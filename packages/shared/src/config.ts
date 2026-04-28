function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  return v !== undefined ? parseInt(v, 10) : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

export const config = {
  ollama: {
    baseUrl: env('OLLAMA_BASE_URL', 'http://127.0.0.1:11434'),
    modelLarge: env('OLLAMA_MODEL_LARGE', 'deepseek-coder-v2:16b'),
    modelSmall: env('OLLAMA_MODEL_SMALL', 'qwen2.5-coder:7b'),
    embedModel: env('OLLAMA_EMBED_MODEL', 'nomic-embed-text'),
  },
  api: {
    port: envInt('API_PORT', 3000),
    host: env('API_HOST', '0.0.0.0'),
  },
  logLevel: env('LOG_LEVEL', 'info'),
  projectRoot: env('PROJECT_ROOT', process.cwd()),
  dataRoot: env('DATA_ROOT', 'data'),
  memory: {
    dbPath: env('MEMORY_DB_PATH', 'data/memory.db'),
  },
  projects: {
    registryPath: env('PROJECT_REGISTRY_PATH', 'data/projects.db'),
    autoRegisterDefault: envBool('PROJECTS_AUTO_REGISTER_DEFAULT', true),
  },
  codeGraph: {
    include: env('CODE_GRAPH_INCLUDE', '**/*.ts,**/*.js,**/*.tsx,**/*.jsx,**/*.py,**/*.rs,**/*.go').split(','),
    exclude: env('CODE_GRAPH_EXCLUDE', 'node_modules,dist,.git,coverage').split(','),
  },
  rag: {
    embeddingDim: envInt('EMBEDDING_DIM', 768),
    maxElements: envInt('VECTOR_MAX_ELEMENTS', 10000),
    maxContextTokens: envInt('RAG_MAX_CONTEXT_TOKENS', 8000),
    vectorsPath: env('VECTORS_PATH', 'data/vectors'),
    graphsPath: env('GRAPHS_PATH', 'data/graphs'),
    embedConcurrency: Math.max(1, envInt('EMBED_CONCURRENCY', 8)),
    fileConcurrency: Math.max(1, envInt('FILE_CONCURRENCY', 4)),
  },
  watcher: {
    enabled: envBool('WATCH_ENABLED', false),
    debounceMs: envInt('WATCH_DEBOUNCE_MS', 1500),
  },
  jobs: {
    maxRetries: envInt('JOB_MAX_RETRIES', 3),
    pollIntervalMs: envInt('JOB_POLL_INTERVAL_MS', 1000),
  },
  agents: {
    parallelism: Math.max(1, envInt('AGENTS_PARALLELISM', 3)),
    testerEnabled: envBool('TESTER_ENABLED', true),
    plannerMaxSteps: Math.max(1, envInt('PLANNER_MAX_STEPS', 50)),
    // v1.30 — when true, the Orchestrator uses the tool-calling Coder
    // (read_file/replace_in_file/create_file/delete_file/done) instead of
    // the patch-based Coder (search/replace JSON). Off by default to keep
    // existing behavior; flip on per-task or per-deployment to validate.
    toolCallingCoder: envBool('TOOL_CALLING_CODER', false),
  },
  safeExec: {
    dryRun: envBool('SAFE_EXEC_DRY_RUN', false),
    backup: envBool('SAFE_EXEC_BACKUP', true),
    backupsPath: env('BACKUPS_PATH', 'data/backups'),
    backupMaxAgeMs: envInt('BACKUP_MAX_AGE_DAYS', 7) * 24 * 60 * 60 * 1000,
    backupPruneIntervalMs: envInt('BACKUP_PRUNE_INTERVAL_HOURS', 24) * 60 * 60 * 1000,
  },
  git: {
    defaultBranch: env('GIT_DEFAULT_BRANCH', 'main'),
    branchPrefix: env('GIT_BRANCH_PREFIX', 'auto/task'),
    commitOnlyIfValid: envBool('COMMIT_ONLY_IF_VALID', true),
  },
  // flat alias used by orchestrator
  JOB_MAX_RETRIES: envInt('JOB_MAX_RETRIES', 3),
};

export function validateConfig(): void {
  const errors: string[] = [];

  try {
    new URL(config.ollama.baseUrl);
  } catch {
    errors.push(`ollama.baseUrl: "${config.ollama.baseUrl}" is not a valid URL`);
  }

  if (!Number.isInteger(config.api.port) || config.api.port < 1 || config.api.port > 65535) {
    errors.push(`api.port: ${config.api.port} must be an integer 1–65535`);
  }

  if (config.rag.embeddingDim <= 0) {
    errors.push(`rag.embeddingDim: ${config.rag.embeddingDim} must be positive`);
  }

  if (config.rag.maxElements <= 0) {
    errors.push(`rag.maxElements: ${config.rag.maxElements} must be positive`);
  }

  if (errors.length > 0) {
    throw new Error(`Config validation failed:\n${errors.map(e => `  ${e}`).join('\n')}`);
  }
}
