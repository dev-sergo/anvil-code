# ROADMAP — RAG System

> Живой документ разработки. Обновлять по мере выполнения задач: менять `[ ]` на `[x]`, обновлять статусы пакетов и дату.

**Статус проекта**: 🟢 v1.32-a.3 — Fixer reliability + Coder retry symmetry. **L4.1 закрыт end-to-end:** bug-injected baseline → byte-perfect fix Fixer'ом в user-service.ts (added createdAt, removed `as User` cast) → validation pass → **commit landed** (real hash, working tree clean). 7 min wall (vs 44 min на v1.32-a.1). FIXER_SYSTEM_PROMPT consolidated ~40→~20 строк, scope expansion guidance moved adjacent to data в user message, no-tool-calls retry: 2 retries с прогрессивно strong nudges (без "Or done() escape"). Symmetric Coder upgrade. 387/387 unit-tests (+5). **Operator-grade bug-fix workflow milestone reached** — 5-iteration arc closed: v1.31.2 → v1.32-a → v1.32-a.1 → v1.32-a.2 → v1.32-a.3.  
**Последнее обновление**: 2026-04-30  
**Цель v1.0**: Локальная связка Ollama → VSCode → Cline / Roo Code без облачных подписок

---

## Состояние пакетов

| Пакет | Статус | Готовность | Примечание |
|-------|--------|-----------|-----------|
| `shared` | 🟢 Готово | 100% | types, config, logger реализованы |
| `model-router` | 🟢 Готово | 100% | OllamaClient (`/api/chat`), ModelRouter с маппингом ролей |
| `memory` | 🟢 Готово | 100% | MemoryStore (SQLite): tasks, adr, failures |
| `safe-exec` | 🟢 Готово | 100% | SafeWriter, BackupManager, DiffEngine |
| `git-engine` | 🟢 Готово | 100% | simple-git обёртка |
| `code-graph` | 🟢 Готово | 100% | ASTParser (TS Compiler API), CodeGraph с персистентностью |
| `rag` | 🟢 Готово | 100% | VectorStore (HNSW), GraphRetriever с гибридным поиском |
| `agents` | 🟢 Готово | 100% | BaseAgent, Planner, Architect, Coder, Tester, Reviewer, Fixer, Orchestrator |
| `job-system` | 🟢 Готово | 100% | MemoryQueue, JobWorker с graceful shutdown |
| `api` | 🟢 Готово | 100% | Fastify: /health, /task, /task/:id, /tasks |
| `mcp-server` | 🟢 Готово | 100% | 7 инструментов, stdio transport, .vscode/mcp.json + .roo/mcp.json |

---

## Итерация 0 — Фундамент

**Цель**: `npm install && npm run build` завершается успешно.  
**Статус**: 🟢 Готово

### Корневые файлы
- [x] `package.json` — workspaces, scripts (build, dev, lint)
- [x] `tsconfig.base.json` — target ES2022, moduleResolution NodeNext, path aliases
- [x] `turbo.json` — build pipeline с зависимостями между пакетами

### Конфиги пакетов (package.json + tsconfig.json)
- [x] `packages/shared/`
- [x] `packages/model-router/`
- [x] `packages/memory/`
- [x] `packages/safe-exec/`
- [x] `packages/git-engine/`
- [x] `packages/code-graph/`
- [x] `packages/rag/`
- [x] `packages/agents/`
- [x] `packages/job-system/`
- [x] `packages/api/`

### Зависимости
- [x] shared: `pino`, `pino-pretty` (dev)
- [x] model-router: зависит от `@rag-system/shared`
- [x] memory: `better-sqlite3`, `@types/better-sqlite3`
- [x] safe-exec: `diff`, `@types/diff`
- [x] git-engine: `simple-git`
- [x] code-graph: `typescript` (Compiler API)
- [x] rag: `hnswlib-node`
- [x] agents: зависит от всех выше
- [x] job-system: зависит от `agents`, `memory`
- [x] api: `fastify`, `@fastify/cors`, `zod`

### Проверка
```bash
npm install
npm run build
# Результат: 11/11 пакетов собраны успешно (~1.2s с кешем)
```

---

## Итерация 1 — Ядро системы

**Цель**: `POST /task` принимается, задача обрабатывается Orchestrator, результат коммитится в git.  
**Статус**: 🟢 Готово  
**Зависит от**: Итерации 0

### `packages/shared/src/`
- [x] `types/index.ts` — TaskDefinition, AgentMessage, FileChange, ModelRole, JobStatus, DiffResult
- [x] `config.ts` — читает все ENV переменные с дефолтами, экспортирует `config`
- [x] `logger.ts` — pino + pino-pretty (только в dev), уровень из `config.logLevel`
- [x] `index.ts` — реэкспорт

### `packages/model-router/src/`
- [x] `ollama-client.ts` — `chat()` → POST `/api/chat`, `embed()` → POST `/api/embeddings`, `healthCheck()` с таймаутом 3s
- [x] `router.ts` — маппинг AgentRole → модель (planner/tester/reviewer=small, architect/coder/fixer=large)
- [x] `index.ts` — реэкспорт

### `packages/memory/src/`
- [x] `store.ts` — MemoryStore: init SQLite, таблицы tasks/adr/failures, CRUD методы
- [x] `index.ts` — реэкспорт

### `packages/safe-exec/src/`
- [x] `backup.ts` — BackupManager: копирует в `data/backups/{md5(path)}-{timestamp}`
- [x] `diff-engine.ts` — DiffEngine.generate(original, modified, filepath) → unified diff
- [x] `writer.ts` — SafeWriter: защита от path traversal, backup, mkdir -p, запись, DRY_RUN
- [x] `index.ts` — реэкспорт

### `packages/job-system/src/`
- [x] `queue.ts` — MemoryQueue: ID через `crypto.randomUUID()`, приоритеты, статусы
- [x] `worker.ts` — polling loop, запуск Orchestrator, graceful shutdown (SIGTERM/SIGINT)
- [x] `index.ts` — реэкспорт

### `packages/api/src/`
- [x] `server.ts` — Fastify + CORS: `GET /health`, `POST /task`, `GET /task/:id`, `GET /tasks`
- [x] `index.ts` — Ollama health check при старте (warning, не crash), запуск Worker, graceful shutdown

### Проверка
```bash
cp .env.example .env
ollama serve &
node packages/api/dist/index.js &

curl http://localhost:3000/health
# { "status": "ok", "ollama": true, "uptime": ... }

curl -X POST http://localhost:3000/task \
  -H "Content-Type: application/json" \
  -d '{"task": "Add a hello world function", "mode": "fast"}'
# { "task_id": "...", "status": "queued" }
```

---

## Итерация 2 — RAG Engine

**Цель**: агенты получают семантический контекст из кодовой базы.  
**Статус**: 🟢 Готово  
**Зависит от**: Итерации 1

### `packages/code-graph/src/`
- [x] `parser.ts` — ASTParser через TypeScript Compiler API; FunctionDeclaration, ClassDeclaration, InterfaceDeclaration, TypeAliasDeclaration из .ts/.tsx/.js/.jsx
- [x] `graph.ts` — CodeGraph: addFile, removeFile, getSymbol, getDependencies (1-hop); персистентность в `data/graphs/graph.json`
- [x] `index.ts` — реэкспорт

### `packages/rag/src/`
- [x] `vector-store.ts` — VectorStore (hnswlib-node, cosine, CJS interop через createRequire); `labelMap` → `data/vectors/labels.json`; авторасширение индекса
- [x] `graph-retriever.ts` — GraphRetriever: embed query → HNSW search → 1-hop зависимости → форматировать контекст (лимит токенов)
- [x] `index.ts` — реэкспорт

### Подключение к Orchestrator
- [x] `indexCodebase(projectRoot)` — сканирует все .ts/.js/.tsx/.jsx файлы
- [x] `retrieveContext()` вызывается в runTask, контекст добавляется в промпты агентов
- [x] `loadFromDisk()` при старте API сервера

### Проверка
```bash
# В логах API сервера при обработке задачи:
# INFO: Indexed codebase: N files, M symbols
# INFO: RAG context retrieved: K symbols
```

---

## Итерация 3 — MCP-сервер (Cline / Roo Code)

**Цель**: Cline и Roo Code используют RAG как MCP-инструмент в VSCode.  
**Статус**: 🟢 Готово  
**Зависит от**: Итерации 2

### Пакет `packages/mcp-server/`
- [x] `package.json` — бинарник `mcp-server`, зависит от shared/rag/code-graph/memory
- [x] `tsconfig.json`
- [x] `src/index.ts` — MCP Server (stdio transport), логирование в stderr, 7 инструментов

### MCP Tools
- [x] `index_codebase` — `{ path }` → индексировать директорию через GraphRetriever
- [x] `search_code` — `{ query, limit? }` → семантический поиск
- [x] `get_related_code` — `{ symbol }` → зависимости символа (1-hop)
- [x] `run_task` — `{ task, mode? }` → POST к RAG API → `{ task_id, status }`
- [x] `get_task_status` — `{ task_id }` → статус задачи (MemoryStore + API fallback)
- [x] `list_decisions` — `{ limit? }` → архитектурные решения (ADR)
- [x] `add_decision` — `{ title, context, decision, consequences? }` → сохранить ADR

### Конфиги интеграции
- [x] `.vscode/mcp.json` — конфигурация для Cline (`"type": "stdio"`)
- [x] `.roo/mcp.json` — конфигурация для Roo Code (`"mcpServers"`)

### Проверка MCP инициализации
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  | node packages/mcp-server/dist/index.js

# Ответ:
# {"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"rag-system","version":"1.0.0"}},"jsonrpc":"2.0","id":1}
```

### Подключение в VSCode
```
Cline: Settings → MCP Servers → конфиг автоматически подхватывается из .vscode/mcp.json
Roo Code: Settings → MCP → конфиг из .roo/mcp.json

Перед использованием запустить API сервер:
node packages/api/dist/index.js
```

---

## Первый запуск (Quick Start)

```bash
# 1. Установить модели Ollama (однократно)
ollama pull deepseek-coder-v2:16b   # large model
ollama pull qwen2.5-coder:7b        # small model
ollama pull nomic-embed-text         # embeddings

# 2. Настроить окружение
cp .env.example .env

# 3. Собрать проект
npm install
npm run build

# 4. Запустить API сервер
ollama serve &
node packages/api/dist/index.js

# 5. В VSCode: Cline/Roo Code автоматически подхватят MCP из .vscode/mcp.json / .roo/mcp.json
# Вызвать: search_code("ваш запрос")
```

---

## После v1.0 — Дальнейшие улучшения

### Надёжность v1.1 (✅ реализовано)
- [x] Zod-валидация вывода всех агентов (защита от кривого JSON от LLM)
- [x] VectorStore: async mutex + атомарная запись (.tmp + rename)
- [x] Promise.allSettled в RAG loader (не теряем оба компонента при сбое одного)
- [x] SQLite close() при graceful shutdown (SIGTERM/SIGINT)
- [x] validateConfig() при старте (URL, порт, размер индекса)
- [x] vitest + 35 тестов (Zod-схемы агентов, SafeWriter path traversal, VectorStore)
- [x] Инкрементальная индексация (SHA-1 хеши файлов в SQLite, пропускает неизменённые)
- [x] MCP runtime-валидация (safeParse в каждом handler)
- [x] Fastify bodyLimit (64KB) + rate-limit (60 req/min)
- [x] Structured вывод search_code (отдельный content block на каждый результат)

### Качество агентов v1.2 (✅ реализовано)
- [x] TestRunner — `npm test` после записи файлов с таймаутом и захватом stdout
- [x] TypeChecker — `tsc --noEmit` после записи файлов
- [x] Валидационный цикл в Orchestrator — Fixer получает реальные ошибки tsc/тестов
- [x] Embedding cache в SQLite — пропускает повторные `embed()` для того же текста+модели

### Resilient orchestration v1.3 (✅ реализовано)
- [x] Per-step error recovery в Orchestrator — упавший шаг не убивает задачу, остальные продолжают выполняться
- [x] DAG-aware skip — шаги с упавшими зависимостями автоматически пропускаются и помечаются в `failures`
- [x] Partial completion в `tasks.result` — `"Completed N/M steps. Failed: a, b"` для аудита
- [x] ADR + failure pattern на каждый сбой шага (через `MemoryStore`)
- [x] Тесты orchestrator (3 сценария: dep-skip, total fail, happy path)

### Live indexing v1.4 (✅ реализовано)
- [x] FileWatcher (chokidar) с дебаунсом (по умолчанию 1500мс) — автопереиндексация при сохранении в IDE
- [x] Очистка удалённых файлов из CodeGraph и VectorStore (`HNSW.markDelete`) + `file_hashes` в SQLite
- [x] Удаление stale-векторов перед re-индексом файла (переименованные/удалённые символы пропадают)
- [x] `WATCH_ENABLED=true` ENV-флаг + graceful shutdown (drain pending events перед close)
- [x] 3 теста FileWatcher (debounce add+change, unlink → removeFile, idempotent start/stop)

### Live progress v1.5 (✅ реализовано)
- [x] `TaskEventBus` (EventEmitter + ring buffer 200 событий на задачу) в `@rag-system/shared`
- [x] Orchestrator эмитит: `plan`, `step_start`, `step_complete`, `step_fail`, `step_skip`, `validation_*`, `commit`, `done`
- [x] JobWorker эмитит `running`/`error`; API эмитит `queued` при enqueue
- [x] `GET /task/:id/stream` — Server-Sent Events: replay history → live → close на `done`/`error`
- [x] Heartbeat каждые 15с (keep-alive через прокси), graceful cleanup при разрыве клиента
- [x] 4 теста TaskEventBus (история, каналы, terminal, ring-buffer cap) + 2 e2e SSE-теста через реальный Fastify

### Полиглот v1.6 (✅ реализовано)
- [x] tree-sitter (0.25) + tree-sitter-python/rust/go в `@rag-system/code-graph`
- [x] `ASTParser` диспетчер по расширению: TS/JS → Compiler API, .py/.rs/.go → tree-sitter
- [x] Lazy load tree-sitter с graceful degradation (если native binding не загрузился — возвращает [])
- [x] Маппинг типов символов: Python (function/class), Rust (function/struct→class/enum→type/trait→interface), Go (function/method/struct→class/interface)
- [x] CODE_GRAPH_INCLUDE расширен: `**/*.py,**/*.rs,**/*.go`
- [x] 6 тестов парсера на 4 языках (TS, Python, Rust, Go) + edge cases (unsupported ext, missing file)

### MCP resources + prompts v1.7 (✅ реализовано)
- [x] **Resources** (read-only context для LLM):
  - `adr://recent` — последние 20 ADR в markdown
  - `adr://{id}` — конкретный ADR (с `list` callback для discovery)
  - `failures://top` — топ failure patterns (защита от повторных ошибок)
  - `tasks://recent` — последние задачи со статусом и result
- [x] **Prompts** (готовые workflow для Cline/Roo):
  - `add-feature` — search → ADR → run_task balanced
  - `fix-bug` — search → related → failures → run_task
  - `refactor` — search → related → ADR → run_task deep
  - `add-tests` — search → run_task с фокусом на тесты
- [x] Capabilities обновлены: `tools + resources + prompts`
- [x] 14 unit-тестов на pure builders (формат markdown, edge cases, корректность messages)

### Наблюдаемость v1.8 (✅ реализовано)
- [x] `taskLogger(taskId)` — pino.child с таглайном `taskId` для всех логов
- [x] Orchestrator + JobWorker используют `taskLogger` — каждая строка имеет `taskId` без ручной передачи
- [x] `BackupManager.prune(maxAgeMs)` — удаляет файлы старше N дней (парсит timestamp из имени файла, `fs.stat` не нужен)
- [x] Конфиг: `BACKUP_MAX_AGE_DAYS=7` (default), `BACKUP_PRUNE_INTERVAL_HOURS=24`
- [x] API запускает `prune()` при старте + setInterval с `unref()` (не держит event loop живым)
- [x] 4 теста backup-prune (старые/свежие, не-matching files, missing dir) + 3 теста taskLogger (bindings, level, isolation)

### Multi-project v1.15 (✅ реализовано)
- [x] `Project` модель + `ProjectRegistry` (top-level SQLite в `data/projects.db`): id (sha1 от absRoot), name, root, createdAt, lastAccessedAt
- [x] `projectPaths(project)` — изолированный layout `data/projects/<id>/{memory.db, vectors/, graphs/, backups/}`
- [x] `ProjectManager` — lazy lifecycle: контекст (MemoryStore + GraphRetriever + SafeWriter + BackupManager + GitEngine + Orchestrator) создаётся при первом обращении, кешируется
- [x] `GraphRetriever` принимает `paths: {vectorsDir, graphsDir}` через конструктор — без cast-хаков
- [x] `JobWorker` — две формы конструктора (legacy single-project, новая multi-project с `ProjectStoreLookup`); per-job `projectId` в Queue
- [x] API endpoints: `GET /projects`, `GET /project/:id`, `POST /project { root, name? }`; `POST /task` принимает поле `project`; `GET /tasks?project=<id>` возвращает только задачи этого проекта
- [x] Авто-регистрация default project на старте из `PROJECT_ROOT` (backwards compat: existing single-project users ничего не замечают)
- [x] Graceful shutdown: `projects.closeAll()` + `registry.close()` корректно освобождают SQLite
- [x] 23 новых теста: 10 для `ProjectRegistry` (id deriv, idempotency, list ordering, touch, unregister), 6 для `ProjectManager` (lazy create, isolation, closeContext/All), 7 e2e API (auto-register, project routing, task isolation между проектами через HTTP)

### VSCode Extension v1.18 (✅ реализовано)
- [x] Новый workspace `packages/vscode-extension` (12-й пакет монорепо), bundle через esbuild → `dist/extension.js` (~18 KB), VSCode инжектит `vscode` модуль
- [x] Activity bar с 🚀 иконкой, два TreeView: **Projects** (со звёздочкой на активном) и **Tasks** (со spinner-иконкой для running)
- [x] Status bar item показывает активный проект; клик → quick-pick переключения
- [x] Команды: `RAG: Refresh`, `Set API URL`, `Run Task` (prompt + mode picker → POST /task → авто-стрим), `Index Active Project` (POST /index → авто-стрим), `Register Project`, `Stream Task Progress`, `Select Active Project`
- [x] OutputChannel "RAG System" — каждый SSE event форматируется в одну читаемую строку: `[HH:MM:SS.mmm] STEP→`, `STEP✓`, `Coder +52b total=1284b ...`, `FILE create src/foo.ts (1247b)`, `IDX 67% (89/132) src/bar.ts`, etc.
- [x] Polling `/tasks` каждые 5с (настраивается `ragSystem.refreshIntervalMs`) — статус queued→running→completed обновляется без ручного refresh
- [x] Активный проект сохраняется в `workspaceState` — каждый workspace помнит свой выбор между перезапусками VSCode
- [x] Auto-pick первого проекта как активного, если ничего не выбрано
- [x] **Новый API endpoint** `POST /index { project?, root? }` — нужен extension'у чтобы триггерить индексацию без MCP
- [x] 12 тестов: 5 для SSE-парсера (heartbeat, malformed JSON, multi-data lines, missing data) + 7 для форматтеров (все 19 event types → readable lines, truncation для длинных chunks, fallback для unknown events, task tooltip, project label со звёздочкой)
- [x] README с инструкциями: `npm install` → F5 (Extension Development Host) → 🚀 в activity bar
- [x] Test isolation fix: HNSW mock теперь реально создаёт `.tmp` файл (раньше `writeIndexSync` был no-op, что ломало `vectorStore.save()` rename → `index.hnsw`); fix применён к 5 тестовым файлам

### Streaming Coder v1.17 (✅ реализовано)
- [x] `BaseAgent.streamLLM` — новый AsyncIterable-примитив (тот же `agent_stream` throttle, но yields chunks для тех, кто хочет реагировать на partial output); `callLLM` теперь обёртка над ним
- [x] `partial-json.ts` — кастомный scanner: string-aware подсчёт `{}`, поддержка markdown fence, ignore unknown top-level keys, character-by-character устойчивость к chunk boundary в любом месте payload
- [x] `CoderAgent.execute(..., onFileReady?)` и `FixerAgent.execute(..., onFileReady?)` — опциональный callback срабатывает на каждом готовом файле, не ждёт остальных; полная Zod-валидация по аккумулированному тексту в конце как раньше
- [x] Новый event type `coder_file_ready { stepId, path, action, size, index }` — Cline видит файлы по мере их генерации
- [x] Orchestrator передаёт callback и в Coder, и в Fixer (с `source: 'fixer'` для разделения в UI)
- [x] Self-healing semantics не сломаны: файлы НЕ пишутся на диск рано, Reviewer видит полный список перед approval
- [x] 14 новых тестов: 10 для partial-JSON parser (string-awareness, escaped quotes, fence, malformed entry skip, 1-byte chunks через все границы, incomplete stream) + 4 для CoderAgent streaming (per-file callback порядок, no-callback fallback, fenced stream, callback ДО разрешения promise)

### Context fidelity & reliability v1.21 (✅ реализовано)

**Цель:** довести систему до working baseline на реальных задачах. Исправлены критические баги, мешавшие e2e-прогонам, и архитектурные дыры в формировании промптов.

**Bugfixes (найдены при первом реальном запуске):**
- [x] **glob ignored node_modules** — абсолютные пути + относительные ignore не исключали 2490 файлов в sandbox-проекте; фикс: `glob('**/*.ts', { cwd: absRoot, ignore })` в [graph-retriever.ts:163-171](packages/rag/src/graph-retriever.ts#L163-L171)
- [x] **Validator на неверном `projectRoot`** — `TypeChecker`/`TestRunner` создавались с `config.projectRoot` (rag-system сам), а не корнем целевого проекта; фикс: добавлен публичный геттер `SafeWriter.root`, Orchestrator использует `this.writer.root`

**Reliability — `COMMIT_ONLY_IF_VALID` (default true):**
- [x] Раньше `runValidationLoop` коммитил даже после VALID✗ (3 attempts exhausted) → main засорялся битым кодом
- [x] Теперь функция возвращает `{ passed, issuesCount }`; Orchestrator проверяет `config.git.commitOnlyIfValid` перед `git.commitChanges()`
- [x] Новый event type `commit_skipped` в SSE; auto-branch создаётся, но коммит пропускается — files остаются в working tree для inspection

**Reliability — graceful Tester + `TESTER_ENABLED`:**
- [x] Один LLM-glitch в Tester (отсутствует поле `action` в JSON) убивал весь шаг → cascade-fail для step2-N
- [x] Теперь `tester.execute()` обёрнут в try/catch — Tester лучшее усилие, шаг продолжается без тестов с warning
- [x] `TESTER_ENABLED=true` (default) — флаг для полного отключения Tester (полезно при iterating над Coder качеством)

**Planner — minimum-step prompting + hard cap:**
- [x] System prompt Planner: explicit правила "trivial tasks = SINGLE step", "never plan tests as separate step", "combine create+register"
- [x] `PLANNER_MAX_STEPS=50` (default) — Orchestrator усекает план до этого числа с вычищением dangling deps
- [x] Понизить до `=1` для smoke-тестов = гарантированный одношаговый прогон

**Context architecture — `ProjectConventions`:**
- [x] Новый модуль [shared/src/project-conventions.ts](packages/shared/src/project-conventions.ts) — читает `package.json`+`tsconfig.json`, определяет: `testFramework` (vitest/jest/mocha/tap), `moduleType` (esm/cjs), `tsStrict`, `moduleResolution`, `needsJsSuffix`, `runtimeFrameworks`, `entryPoints`
- [x] `buildPromptContext` в [shared/src/prompt-context.ts](packages/shared/src/prompt-context.ts) — собирает 4 секции: Project Conventions → Existing project files (full source) → Related snippets → Architectural design
- [x] Orchestrator: при `executeStep` читает full source существующих файлов из retrieved context (через `retrieveContextItems` + `fs.readFileSync`), передаёт в Coder/Fixer
- [x] Сильные маркеры границ файлов: `===== BEGIN FILE: path =====` / `===== END FILE: path =====` (uppercase, не валидный TypeScript) — модель не может случайно скопировать в output

**System prompts — Coder/Fixer/Tester:**
- [x] Coder: 7 явных правил (preserve imports при modify, follow conventions, prefer modify over create, .js suffix для NodeNext, никогда не копировать file markers, не писать тесты, preserve trailing newline)
- [x] Fixer: surgical edits, "Cannot find name X" → restore import (не удалять код)
- [x] Tester: explicit vitest mocking guide (`vi.fn()`, `vi.spyOn()`, запрет `as jest.Mock`), `app.inject()` вместо mock-of-app, exact import paths

**Конфигурация:**
- [x] `COMMIT_ONLY_IF_VALID=true` — git коммит только при passing validation
- [x] `TESTER_ENABLED=true` — выключатель TesterAgent
- [x] `PLANNER_MAX_STEPS=50` — hard cap на размер плана

**E2E sandbox-тесты:**
- [x] Task 1: "Add a GET /health endpoint that returns {status: 'ok'}" — 1 step, 1 файл, +5/-1 строка, идиоматический diff, validation passed, COMMIT
- [x] Task 2: "Add Zod schema validation to POST /users" — 1 step, 1 файл, корректная schema (`name min 2`, `email format`), импорт `zod` добавлен, существующие routes сохранены, COMMIT

**Известные ограничения:**
- ⚠️ TesterAgent на `deepseek-coder-v2:16b` упорно генерирует jest-style моки (`as jest.Mock`) вопреки explicit vitest examples в промпте — модель не удерживает multi-rule инструкции для tests; обход = `TESTER_ENABLED=false`
- ⚠️ Cross-step consistency решена частично в v1.22 (см. ниже)
- ⚠️ Validation ловит только typecheck+unit-tests, не runtime smoke (стёртый `app.listen()` прошёл validation в одном из прогонов)

### Cross-step consistency & prompt hardening v1.22 (✅ реализовано)

**Цель:** многошаговые задачи (2+ шагов на одном или связанных файлах) не должны разрушать работу соседних шагов.

**v1.22 — Cross-step state propagation:**
- [x] `executeStep` принимает snapshot `previousChanges: FileChange[]` от уже выполненных шагов
- [x] `buildPromptContext` поддерживает поле `newlySources: Array<{path, content}>` — новый блок "Recently modified by previous steps (CURRENT state — SUPERSEDES Existing project files)" с маркерами `===== BEGIN MODIFIED / END MODIFIED =====`
- [x] Coder/Fixer prompts усилены правилом 2a / 1a: "Recently modified" блок имеет приоритет над disk-version
- [x] Dedupe: если файл и в newlySources и в ragFilePaths — disk-version не показывается, чтобы не сбивать модель
- [x] Fixer в validation loop тоже получает full source через newlySources всех `allFileChanges` — может видеть импорты при патче

**v1.22.1 — Same-file sequential planning:**
- [x] Planner system prompt rule 6: "If two steps modify the SAME file, the second's `dependencies` MUST include the first's id" — даёт scheduler'у linearize одного-файловых правок
- [x] `PLANNER_MAX_STEPS` ENV (default 50) — Orchestrator усекает план с очисткой dangling deps; для smoke-тестов можно ставить =1

**v1.22.2 — `const` exports indexing:**
- [x] AST-парсер ([code-graph/src/parser.ts:83-115](packages/code-graph/src/parser.ts#L83-L115)) теперь индексирует `export const X = {...}` (object literal, arrow, function expression, call expression, class expression) — раньше пропускал
- [x] `UserService = { ... }` style сервисы попадают в RAG, Coder видит реальный API, не галлюцинирует методы

**v1.22.3 — Coder/Fixer/Tester prompt hardening:**
- [x] Правила 9-13 в Coder prompt: entry-point preservation (Fastify init / app.listen / env vars), no `require()` in ESM, no placeholder comments, file extension rule (`.ts` source / `.js` import suffix), Fastify quick reference (hook signatures, real type exports, `reply.elapsedTime`)
- [x] Planner rule 6a: Cross-file coupled changes (create + register) MUST be a single step — наименее склонно к рассинхронизации
- [x] Tester explicit vitest mocking guide (vi.fn, vi.spyOn, запрет `as jest.Mock`)

**Эмпирические findings (тестирование на sandbox-проекте):**

| Задача | `deepseek-coder-v2:16b` | `gemma2:27b` |
|--------|--------------------------|----------------|
| L1 атомарные (1 файл) | ✓ stable, 8-10/10 | (не отдельно тестировано) |
| L2.1 cross-file middleware (2 файла) | ❌ 5 попыток, систематически разрушал `server.ts` | ✓ 1 попытка, 7-8/10 |
| L2.2 refactor (extract schema) | n/a | ⚠️ 70% (semantic miss — `nullable()` вместо required) |
| L2.3 multi-file feature (3 файла, чистый main) | n/a | ✓ 8/10 green commit |
| L3.1 class refactor | n/a | **✓ 10/10 perfect** |
| L2.3 на расширенном sandbox (после L3.1 merge) | n/a | ❌ регрессия 5/10 — `UserService.users` галлюцинация |

**Ключевой вывод:**
- **Размер модели важнее prompt-engineering.** 14+ rules в Coder prompt'е не вытащили `deepseek-coder-v2:16b` на L2; gemma2:27b делает с первой попытки на той же базе.
- **Cumulative state деградирует gemma2:27b.** На чистом main стабильно. На накопленном проекте — галлюцинирует методы, пишет несуществующие property accesses.
- **Реалистичный позиционинг:** atomic-задачи на свежем коде (L1-L2 на clean state). Cumulative growth требует архитектурных изменений.

**Архитектурное ограничение:** Coder выводит **полный текст файла** (`{path, content, action}`), что физически позволяет стереть существующий код. Никакие промпты ("preserve existing imports") этого не лечат. Решение — переход на patch/diff-based editing (см. v1.23 ниже).

**Конфигурация v1.22 в `.env`:**
- `COMMIT_ONLY_IF_VALID=true` — main защищён от broken validation commits
- `TESTER_ENABLED=false` — отключение шумного Tester (известное ограничение модели)
- `PLANNER_MAX_STEPS=50` — практический cap
- `OLLAMA_MODEL_LARGE=gemma2:27b` — рекомендуемая модель для LARGE (architect/coder/fixer)

### Patch-based code editing v1.23 (✅ реализовано)

**Корневая проблема всех L2-провалов до v1.23:** Coder выводил файл целиком, что физически позволяло стирать существующий код. Никакие prompt rules не лечили этот класс.

**Реализация — search/replace blocks (паттерн Aider):**
- [x] `FileChange` в `shared/src/types/index.ts` — discriminated union: `create | modify | delete`. Для `modify` — массив `edits: Array<{search, replace}>`, нет `content`.
- [x] `applyEdits()` в [safe-exec/src/edit-applier.ts](packages/safe-exec/src/edit-applier.ts) — точный match (zero и multiple matches abort), edits применяются по порядку, atomic (либо все, либо ни одного)
- [x] `SafeWriter.execute` switches on action; для modify читает диск, применяет edits, пишет результат
- [x] Coder/Fixer system prompts полностью переписаны под edit-block format (~14 правил, включая Fastify cheat sheet, .ts/.js suffix rule, no placeholder comments)
- [x] Tester schema ограничен `action: 'create'` (он только создаёт новые тестовые файлы)
- [x] `partial-json` updated для streaming union schema; новый `partialFileSize()` helper
- [x] **v1.23.1** — entry-point файлы (`server.ts/main.ts/...`) всегда включаются в `ragFilePaths`. Без этого Coder не видел реальный server.ts через RAG (vector search не находил — у него нет собственных символов) и галлюцинировал search блоки.
- [x] **v1.23.2** — `dedupeChangesByPath` в Orchestrator перед записью. Если несколько `modify` на один path — edits сливаются в одно atomic apply. Иначе первый batch применялся, второй fail'ил → partial damage.
- [x] **v1.23.3** — retry-with-real-content. Когда applyEdits fails (search not found), Fixer вызывается ОДИН раз с literal current content файла как `<<<<<<< CURRENT FILE\n...\n>>>>>>> END`. Iterative editing pattern из Aider.
- [x] 196 unit-тестов зелёные после миграции; 10 новых тестов для applyEdits edge cases

**Эмпирические результаты (детально — `docs/benchmarks/runs/2026-04-27-v1.21-v1.23-multi-model.md`):**

| Задача | deepseek-coder-v2:16b | gemma2:27b | qwen2.5-coder:32b |
|--------|----------------------|------------|---------------------|
| L1 atomic | ✓ stable | — | — |
| L2.1 cross-file (clean) | ❌ 5 попыток, разрушал server.ts | ✓ 7-8/10 | ✓ **10/10 GREEN** |
| L2.3 multi-file (clean) | — | ✓ 8/10 | — |
| L3.1 class refactor (clean) | — | ✓ **10/10** | — |
| L2 на cumulative state | — | ❌ регрессия | ❌ регрессия (search minification) |

**Ключевые findings:**
- **Размер модели > промпт-инжиниринг.** 14+ правил не вытащили deepseek-coder-v2:16b на L2; gemma2:27b делает с первого раза.
- **Patch-based — главный safety win.** Файл никогда не разрушается, даже при неверном edit. main защищён.
- **Cumulative state — фундаментальное ограничение** локальных моделей. Не лечится правилами. Видимо нужен Direction 2 (repo-map).
- **Новый failure mode на patch-based:** qwen-coder:32b "минифицирует" многострочный код в search блоках в одну строку → strict match fail. Retry с real content тоже срывается (Fixer эмитит empty search → Zod fail).
- **Silent partial completes:** L2.2 cumulative — schema создалась, integration не записалась, task report'ит `done`. Нужен `commit_partial` event.

**Известные ограничения после v1.23:**
- ⚠️ Cumulative state нестабилен на любой из 3 моделей
- ⚠️ Search minification на qwen2.5-coder:32b — нужен whitespace-tolerant fallback в applyEdits
- ⚠️ Silent partial failures не сигнализируются — task report'ит `done` при частичном успехе
- ⚠️ TesterAgent на vitest проектах упорно пишет jest-моки — обход `TESTER_ENABLED=false`

### Phase 2 — продолжение (📋 планируется)

После v1.23 систематические улучшения. Каждое — отдельная итерация с полным regression run в `docs/benchmarks/runs/`. После всех — сравнительный анализ.

#### v1.24 — Whitespace-tolerant edit matching (✅ реализовано)

**Цель:** Атакует failure mode v1.23 — search minification на qwen2.5-coder:32b (модель «сжимает» многострочный код в search-блок в одну строку, strict match отвергает).

- [x] `applyEdits` strict-first → tolerant fallback с `\s+`-нормализацией (search split by `\s+`, segments escaped, joined with `\s+`); replace остаётся буквальным (заменяется matched slice оригинала)
- [x] `ApplyResult.ok=true` теперь содержит `tolerantEdits: number[]` — индексы edits, прошедших только через fallback. Strict-only paths возвращают `[]`
- [x] Tolerant требует уникального match (zero / ≥2 → abort с сообщением `ambiguous under whitespace-tolerant matching`)
- [x] Whitespace-only search guard (`!/\S/.test(search)`) — отказ от паттернов без non-whitespace символов
- [x] Regex metachar escape (`. * + ? ^ $ { } ( ) | [ ] \`) во всех сегментах
- [x] `SafeWriter.execute` логирует `warn` с `tolerantEditIndices` когда сработал fallback — сигнал для run-файлов
- [x] 9 новых unit-тестов в `edit-applier.test.ts` (20/20 в файле): minified one-line→multi-line, tabs↔spaces, regex metachars, ambiguity rejection, strict-wins-when-both-possible, replace verbatim, whitespace-only guard, mixed strict+tolerant — все покрыты
- [x] Mock в orchestrator-тестах обновлён под новое поле — 205/205 общая зелёная

**Бенчмарк-прогон 2026-04-28** (`qwen2.5-coder:32b-instruct`):
- L1.1 clean: ✓ 10/10 commit (1 step, 1 файл)
- L2.1 clean: ❌ 5.2/10, `commit_skipped` — model variance, забыл module augmentation для `request.start` (регрессия от 10/10 baseline 2026-04-27, не v1.24's fault)
- L2.3 cumulative: ⚠️ 5.0/10, **partial commit** — 2 из 3 файлов закоммичены (types.ts + routes/users.ts), user-service.ts остался uncommitted на auto-branch
- **Tolerant fallback ни разу не сработал за все 3 прогона** — failure modes были structural (paraphrased / hallucinated content), не whitespace minification. Conservative path сработал правильно — false-positive matches отсутствуют

**Вывод:** v1.24 — insurance policy. Имплементирована корректно, юнит-тестами покрыта, не регрессирует strict path. На live-моделях этот failure mode не пробил, но цена нулевая. **Главный actionable** — silent partial completion на L2.3 повторно подтверждена → v1.28 повышается в приоритете.

#### v1.25 — Repo-map в каждом промпте (✅ реализовано)

**Цель:** Дать модели authoritative inventory «что существует» — компактный список файлов с сигнатурами символов из AST. Главная гипотеза для пробития cumulative ceiling.

- [x] Новый модуль [packages/code-graph/src/repo-map.ts](packages/code-graph/src/repo-map.ts) — `buildRepoMap(graph, projectRoot, opts?)`: per-file relative path + indented signatures (class methods через regex по `text` без AST re-walk; interface fields; function/type/variable headers); token budget (default 6000 chars ≈ 1500 tokens) с greedy fill; `highlightFiles` (entry points + paths из `previousChanges`) — pinned at top, никогда не truncated; control-flow keywords (if/for/while/...) фильтруются из method extraction
- [x] `PromptContextInput.repoMap?: string` — новое опциональное поле, рендерится как **второй** блок промпта между Project Conventions и Recently-modified/Existing-files
- [x] `GraphRetriever.graph` getter — exposes live CodeGraph для рендереров без отдельного snapshot
- [x] `Orchestrator.renderRepoMap(extraHighlights)` — helper, вызывается на каждом buildPromptContext (Planner / Architect / Coder / Reviewer / retry-Fixer / validation-Fixer); строится cheap из in-memory графа; для cross-step видимости передаются paths из `previousChanges`
- [x] 10 новых unit-тестов в `repo-map.test.ts` (10/10 зелёные): empty graph → '', function/class/interface/variable rendering, budget enforcement с footer truncation, highlightFiles ordering, alphabetic sort, signature truncation 120 chars, control-flow filter, regex-metachar handling
- [x] Mock в `orchestrator.test.ts`: `retriever.graph = { getAll: () => [] }` — пустой граф рендерится в '' и не ломает scheduling-tests
- [x] 215/215 общая зелёная, 12/12 пакетов собрались

**Бенчмарк-прогон 2026-04-28** (`qwen2.5-coder:32b-instruct`):

| Задача | v1.24 baseline | v1.25 result | Δ |
|---|---|---|---|
| L1.1 clean | 10/10 ✓ | 10/10 ✓ × 2 (reproducible) | flat |
| L2.1 clean | 5.2/10 commit_skipped | **7.4/10 ✓ + 5.4/10 ✓** (mean 6.4) | +1.2, оба коммитят |
| **L2.3 cumulative** | 5.0/10 partial commit | **9.2/10 ✓ GREEN + failed + 4.6/10 skipped** | +4.2 best-of |

**Главное достижение:** L2.3 cumulative впервые в истории проекта landed **GREEN commit 9.2/10**, с целостной семантикой 3 файлов (types + service + routes). Модель добавила бонусом `UserService.delete()` метод — senior-engineer touch. Прежний потолок был 5.0/10 partial commit с silent missing file. **Repo-map работает на target failure mode.**

**Variance высокая на L2.3:** 1/3 GREEN. Главный источник — Planner output: 1-step coupled → success, 2-step → cross-step drift даже с repo-map. v1.27 (per-agent context tailoring) должна стабилизировать.

**На L2.1 модель упорно использует `onRequest` вместо `onResponse`** в обоих ранах. Repo-map не лечит — Fastify hook signatures не индексированы в sandbox source. Это target для v1.26 (few-shot examples).

**Tolerant fallback (v1.24) всё ещё ни разу не сработал** за два прогона. Permanent insurance, не двигает скоры.

**Surfaced two pre-existing orchestrator bugs** (не v1.25 регрессии — добавлены как v1.25.1/v1.25.2 ниже).

#### v1.25.1 — Validation-Fixer write throws не крашат task (✅ реализовано)
- [x] Wrap `this.writer.execute(fixed)` в `runValidationLoop` ([orchestrator.ts](packages/agents/src/orchestrator.ts)) в try/catch — на throw логируем `'Validation-Fixer write failed; treating as another validation issue and continuing'` и продолжаем loop. Outer цикл либо ретрайт (если budget есть), либо fall-through на `commit_skipped` — working tree остаётся в auto-branch для inspection
- [x] Новый тест в `orchestrator.test.ts` (8/8 в файле): TypeChecker фейлится → Fixer возвращает edit с unmatched search → writer.execute throws → task завершается со `status: 'completed'` (не падает); `validation-failure:*` запись в saveFailure фиксируется
- **Атаковал:** uncaught throw из L2.3 #2 на v1.25 — валидаторский Fixer fail обрушал всю задачу со `status: 'failed'`. В v1.24 не проявлялось случайно (Fixer's edits тогда применялись успешно).

#### v1.25.2 — Reindex прунит graph по deleted files (✅ реализовано)
- [x] `indexCodebase` ([graph-retriever.ts](packages/rag/src/graph-retriever.ts)) после glob строит `discovered = new Set(files)` и для каждого пути в `codeGraph.getAll().map(s => s.filePath)` НЕ присутствующего в discovered — вызывает `removeFile(known)` (удаляет символы из графа + векторы из VectorStore + file_hash из MemoryStore)
- [x] `index_done` event и финальный logger.info теперь содержат поле `pruned: number`; message добавляет `, pruned N` если pruned > 0
- [x] Новый тест в `index-events.test.ts` (6/6): индексируем 3 файла → удаляем один с диска → reindex прунит, граф содержит 2 символа, `index_done.data.pruned === 1`, file_hash удалённого файла очищен
- **Атаковал:** "ghost files" в repo-map после `git reset --hard`. На v1.25 surfaced когда L2.1 #1 на свежем reset тихо не создал middleware — repo-map утверждал что requestLogMiddleware уже есть (stale от прошлого прогона), модель просто зарегистрировала его в server.ts → typecheck fail.

#### v1.26 — Few-shot examples в Coder/Fixer (✅ реализовано)

**Цель:** Заменить абстрактные prose rules в системных промптах на worked examples (input → правильный output). Локальные модели гораздо лучше следуют примерам.

- [x] **CoderAgent.systemPrompt** — секция WORKED EXAMPLES с 2 примерами:
  - **Example A:** Fastify middleware с `app.addHook("onResponse", ...)`, точные поля `{method, url, statusCode, durationMs}`, `reply.elapsedTime`, два-edit modify `server.ts` с surrounding context. Атакует L2.1 hook-misuse + field-drift (v1.25 N=2 mean=6.4)
  - **Example B:** modify одного метода класса, многострочный search byte-for-byte, минимальный one-edit one-file output. Демонстрирует patch-based discipline
- [x] **FixerAgent.systemPrompt** — секция WORKED EXAMPLES с 2 примерами:
  - **Example A:** TS2304 "Cannot find name X" → восстановить пропущенный import (НЕ удалять call site)
  - **Example B:** TS2362 на Date arithmetic → `.getTime()` (smallest-possible edit)
- [x] Прозаические rules сохранены — examples их дополняют, не заменяют
- [x] Никаких code logic changes — 217/217 тестов остаются зелёными, 12/12 пакетов собрались

**Бенчмарк-прогон 2026-04-29** (`qwen2.5-coder:32b-instruct`, N=2):

| Задача | v1.25 mean | **v1.26 mean** | Δ |
|---|---|---|---|
| L1.1 clean | 10.0 | **10.0** | flat |
| L2.1 clean | 6.4 (variance 2.0) | **10.0 (variance 0)** | **+3.6** |
| L2.3 cumulative | ≈4.6 (incl. infra-fail) | **7.9** | **+3.3** |

**Главное достижение:** L2.1 lifted from variance hell to **deterministic 10/10**. Обе попытки выдали byte-identical output, точно повторяющий Example A — `onResponse` hook, точные поля `{method, url, statusCode, durationMs}`, `reply.elapsedTime`. На v1.25 модель упорно использовала `onRequest` несмотря на 14 prose rules. Few-shot example fix'нул это с одного промпт-edit'а.

**L2.3 cumulative:** 6.8 partial + 9.0 full GREEN. No hard fails, no commit_skipped. Variance остаётся (Planner иногда 1-step coupled, иногда 3-step → cross-step drift), но floor выше всех Phase 2 итераций.

**Mean across all 6 runs: 9.3/10** (v1.25 был 7.4 на valid runs).

**Surfaced finding:** Reviewer стал новым variance source на cumulative L2.3 — три раза отклонил Coder output для step3 в #1 run. Кандидат на v1.26.1 (few-shot для Reviewer prompts) если pattern повторится.

#### v1.27 — Per-agent context tailoring (⚠️ partial — see run file)

**Two changes attempted; one landed, one reverted после empirical regression.**

##### ✅ Landed: Planner few-shot examples
- [x] [planner.ts](packages/agents/src/planner.ts) — секция WORKED EXAMPLES с 2 примерами:
  - **Example A:** Multi-file feature (3 coupled files) → ОДИН step naming all three. WRONG plan с 3 раздельными steps показан для контраста. Атакует L2.3 cumulative variance из v1.26 (rule 6a)
  - **Example B:** Two unrelated features → 2 independent steps с empty dependencies. Различает "couple together" от "actually separate"
- [x] Sanity check post-revert: L2.3 cumulative single-shot landed GREEN 9.0/10 (1-step coupled plan), L2.1 single-shot 10/10 — baseline восстановлена

##### ❌ Reverted: Lean Architect/Reviewer/Tester context

Hypothesis: Architect/Reviewer/Tester не нуждаются в full source — Coder пишет код, остальные агенты только design/review/test. Стрипуем context → 30-50% token savings без quality hit.

**Эмпирическая фальсификация на 5 прогонах:**
- L1.1: оба run'а 10/10 quality, но wall time **3-5× медленнее** v1.26 (6 + 10.5 мин vs 2.16 + 2.15 мин); один run сделал ненужное scope creep в server.ts
- L2.1: variance взорвалась — `[10, 1]` mean 5.5 spread 9 (vs v1.26 `[10, 10]` zero-variance). #2 — катастрофа: Coder выдал `action: 'modify'` для несуществующего файла → SafeWriter throw → unrecoveredWrites → ничего не закоммичено
- L2.3 cumulative: **commit_skipped после 3 Fixer rounds**. routes/users.ts разрушен (duplicate POST body, embedded DELETE inside POST). Wall 23 мин (vs v1.26 best 7 мин)

**Вывод:** Architect's `design` field load-bearing для Coder. Lean Architect → generic design → Coder теряет специфику (file existence cues, exact patterns) → cascading regression. Per-agent context tailoring сложнее чем кажется — agents share information через handoffs.

**[orchestrator.ts](packages/agents/src/orchestrator.ts) revert'нут к v1.26 контекстам.** Sanity-check после revert подтвердил восстановление baseline: L2.1 10/10, L2.3 9.0/10, wall times normalized.

**Detailed empirical record:** [docs/benchmarks/runs/2026-04-29-v1.27-per-agent-context.md](docs/benchmarks/runs/2026-04-29-v1.27-per-agent-context.md).

##### Future work на ту же тему
- Если возвращаться к per-agent tailoring — делать **по одному агенту за итерацию** с benchmark gate. Reviewer самый безопасный кандидат (он получает full patch как parameter). Architect и Tester — context preserved.
- Идея для post-applyEdits sanity check (brace balance) — surface'ила себя на malformed routes/users.ts; future hardening item.

#### v1.28 — Silent partial completion events (✅ реализовано)

**Цель:** Раньше partial state landed silently — пользователь видел только `done` event и не знал, что часть task'а не пришла. На L2.3 #1 v1.26 step3 (DELETE endpoint) failed после 3 Reviewer rounds, файл routes/users.ts остался без изменений, остальные 2 файла закоммичены — task report'ил `done` без сигнала о partial state.

- [x] Новый event type `'commit_partial'` в [TaskEventType](packages/shared/src/task-events.ts) — между `commit_skipped` и `done` чтобы SSE-клиенты успели отреагировать в строгом порядке
- [x] Orchestrator после initial+retry write phase отслеживает `unrecoveredWrites: string[]` — paths, которые failed в обеих фазах (включая случай когда retry-with-feedback не смог даже сгенерить кандидат-edit, например для отсутствующих файлов)
- [x] Эмит `commit_partial` event строго ПЕРЕД `done` если есть failed steps ИЛИ unrecovered writes; payload: `{ failedStepIds, unrecoveredWrites, completedSteps, totalSteps }`; message содержит human-readable reasons
- [x] `done.data` расширен полями `partial: boolean`, `failedStepIds: string[]`, `unrecoveredWrites: string[]` — на full success они empty/false, на partial — заполнены
- [x] Финальный logger.info теперь содержит `unrecovered: N`
- [x] 2 новых теста в `orchestrator.test.ts` (10/10): partial flow эмитит `commit_partial` перед `done` с правильным payload и порядком; clean flow НЕ эмитит `commit_partial` и `done.data.partial === false`
- [x] 219/219 общая зелёная, 12/12 пакетов собрались

**Атаковал:** silent partial completion из L2.3 cumulative #1 v1.26 — теперь UX чётко сигнализирует о неполном выполнении. SSE клиенты (VSCode extension, Cline, Roo) могут показать warning badge и показать список fail'ed steps + unrecovered files.

**Никаких изменений в behavior pipeline'a** — это чистый observability win, не влияет на бенчмарк scores. Отдельный benchmark не требовался.

### Phase 3 — Architecture (🔴 v1.30 урgent после v1.29 scale findings)

**Фаза 2 закрыта. v1.29 scale validation на 91-файловом rag-system показала, что patch-based Coder не масштабируется. Phase 3 — архитектурный сдвиг — необходим для крупных проектов (главная цель проекта).**

#### v1.29 — Scale validation на rag-system (✅ выполнено, результат: blocked by Coder ceiling)

Изолированная копия rag-system как target (91 TS файл, 65 с символами, 6717 LOC). Индексация 3.5s / 210 vectors — OK.

**Atomic L1':** /version в server.ts → 0/10 (search-not-found cascade на всех 5 LLM-вызовах: Coder + retry-Fixer + 3 × validation-Fixer).
**Atomic L1'':** getSize() в queue.ts → ~4/10, commit_skipped, scope creep в test files.

**Главные findings:**
- Patch-based Coder hallucinates `search`-блоки — не матчатся с реальными файлами на medium scale
- v1.23 retry-with-real-content + v1.25.1 validation-Fixer try/catch предотвращают краши, но **не решают** проблему
- Repo-map default 6KB budget overflow'ит уже на 91 файле (39 of 65 omitted), alphabetic sort даёт bias в test files → scope creep
- Indexing + HNSW JSON storage держат scale fine — Phase 4 не блокирующий
- Подробный анализ: [docs/benchmarks/runs/2026-04-29-v1.29-scale-rag-system.md](docs/benchmarks/runs/2026-04-29-v1.29-scale-rag-system.md)

#### v1.29.1 — Repo-map at scale (✅ реализовано)

**Цель:** Лечит две проблемы из v1.29 scale benchmark — default 6KB budget overflow на 91-файловом проекте (60% файлов truncated) и alphabetic-sort bias в test files (вызывал scope creep).

- [x] [packages/code-graph/src/repo-map.ts](packages/code-graph/src/repo-map.ts):
  - `DEFAULT_MAX_BYTES` 6000 → **16000** (~4000 tokens) — сайзинг под medium projects (100-200 файлов)
  - `isTestFile(relPath)` helper + regex `(?:^|\/)__tests__\/|\.(?:test|spec)\.[jt]sx?$` — детектит как `__tests__/` пути, так и `.test.`/`.spec.` суффиксы
  - Render order: highlights → production → tests; greedy fill из shared budget, tests truncated first
  - Section headers `## Production sources` / `## Tests` отображаются ТОЛЬКО когда обе группы непусты (на single-section проектах headers убираются — sandbox case unchanged)
  - Footer truncation message раздельно для прод и тестов: `"N more production files omitted"` / `"N test files omitted"`
- [x] 4 новых unit-теста (14/14 в файле, 223/223 общая):
  - production файлы идут перед test файлами + section headers correct order
  - section headers omitted при single-group проектах
  - tests truncated first под tight budget, production остаётся видимой
  - regex детектит `.test.` и `.spec.` naming, не только `__tests__/`

**Эмпирическое улучшение на rag-system-target (91 файл, 65 with symbols):**

| | До v1.29.1 | После v1.29.1 |
|---|---|---|
| Repo-map bytes | 5975 | 16084 |
| Tokens | ~1494 | ~4021 |
| Production truncated | 60% (39/65) — bias toward tests | ~10% (5/65) — production-first |
| Section structure | flat alphabetic | `## Production sources` → `## Tests` |
| Scope-creep target risk | high | low (тесты явно отделены) |

**Future hardening:** при переходе на large projects (500+ файлов) — увеличивать budget динамически или вводить hierarchical view (package → file → symbols). Не блокирует v1.30, можно сделать вместе с tool-calling.

#### v1.30 — Tool-calling Coder (✅ реализовано — Coder; Fixer пока patch-based)

**Цель:** Заменить patch-based Coder (JSON `{search, replace}` блоки) на tool-calling loop. v1.29 показала, что byte-perfect quoting ломается на 91-файловом проекте. Решение: модель навигирует через tools с координатами, не quote'ы.

- [x] [packages/model-router/src/types.ts](packages/model-router/src/types.ts) — `ToolDefinition`, `ToolCall`, `ToolCallResponse`, `ToolLoopMessage` (OpenAI-compatible)
- [x] [packages/model-router/src/ollama-client.ts](packages/model-router/src/ollama-client.ts) — `chatWithTools()` non-streaming + **inline-content fallback parser** (`extractInlineToolCalls`) для qwen2.5-coder/gemma2 quirk: они эмитят tool calls в `content` как concatenated JSON, не в structured `tool_calls`. String-aware brace-matched scanner. Без этого fix v1.30 не работает на Ollama
- [x] [packages/agents/src/working-set.ts](packages/agents/src/working-set.ts) — in-memory file state с lazy disk read; `replace(path, startLine, endLine, newText)` 1-indexed; `toFileChanges()` дёт FileChange[] для существующего write/validation pipeline
- [x] [packages/agents/src/tool-calling-coder.ts](packages/agents/src/tool-calling-coder.ts) — 5 tools (`read_file`/`replace_in_file`/`create_file`/`delete_file`/`done`), dispatcher, loop с MAX_TOOL_CALLS=50; emit `coder_file_ready` events для SSE-клиентов
- [x] `config.agents.toolCallingCoder` flag (`TOOL_CALLING_CODER` env) — Orchestrator выбирает Coder runtime; default false (preserves baseline; flip on per-task для validation)
- [x] 31 новый unit-test (14 WorkingSet + 11 dispatcher + 6 chat-with-tools); общая 254/254 зелёная

**Бенчмарк-прогон 2026-04-29 (`qwen2.5-coder:32b-instruct`, `TOOL_CALLING_CODER=true`):**

| Задача | v1.29 patch-based | **v1.30 tool-calling** | Δ |
|---|---|---|---|
| Sandbox L2.1 (5 файлов) | 10/10 (deterministic) | 8.2/10 GREEN | -1.8 (стиль hit) |
| rag-system /version (91 файлов) | **0/10** (5 search-not-found cascades) | **5.2/10** (server.ts surgical diff GREEN, package.json clobbered → commit_skipped) | **+5.2 на core failure mode** |
| rag-system getSize (91 файлов) | ~4/10 commit_skipped | 4.8/10 commit_skipped (logic correct, placement off — outside class) | flat (другая failure) |

**Главное достижение:** **v1.29 scale ceiling сломан**. server.ts получил `app.get('/version', ...)` с byte-perfect surgical edit прямо после `/health` — то, что patch-based Coder не мог сделать ни одной из 5 LLM-попыток. На sandbox L2.1 tool-calling Coder тоже работает (8.2/10 GREEN, byte-not-quite-identical to v1.26 reference, but functional).

**Новые failure modes (v1.30.1 targets):**
1. **Scope creep в unrelated files.** `/version` task → wiped `package.json`, создал `vitest-setup.ts`. `getSize` task → создал `__tests__/` директорию. Patch-based Coder был bounded требованием byte-quote'ить файл; tool-calling этого ограничения не имеет — system prompt должен быть строже
2. **Structural placement errors.** getSize() оказался ВНЕ класса — модель не точно понимала где class boundary в queue.ts. Lines fidelity без structural understanding
3. **Reviewer approves "no changes".** Sandbox first run — Coder выдал 0 файлов, Reviewer одобрил. Reviewer должен флагать empty output как failure

**Default behavior:** `TOOL_CALLING_CODER=true` opt-in только. v1.30.1 закрывает scope discipline ДО switch'а default'a. Sandbox-scale users остаются на patch-based deterministic 10/10 пути.

**Подробный run-файл:** [docs/benchmarks/runs/2026-04-29-v1.30-tool-calling-coder.md](docs/benchmarks/runs/2026-04-29-v1.30-tool-calling-coder.md)

#### v1.30.1 — Scope discipline в tool-calling Coder (✅ реализовано)

**Цель:** Лечит scope creep failure mode из v1.30 — модель писала в `package.json` (wipe) и создавала unrelated `vitest-setup.ts`. Теперь dispatcher enforce'ит, что Coder может писать только в paths, явно упомянутые в task description.

- [x] [packages/agents/src/tool-calling-coder.ts](packages/agents/src/tool-calling-coder.ts):
  - `extractAllowedPaths(taskDescription)` — regex picks paths с known source extensions (TS/JS/JSON/Python/Rust/Go/MD/etc.); strips quotes/parens/leading-`./`. **Critical regex bug fixed**: alternation `js|json` left-to-right, `.json` matched `.js` prefix → added `\b` word-boundary
  - `ALWAYS_FORBIDDEN_PATTERNS` — package.json, lockfiles, tsconfig, vitest/jest configs, .env, turbo.json, .gitignore. Operator opt-in: если task explicitly names — bypass forbidden
  - `WritePolicy { allowed, forbiddenPatterns }` + `isWriteAllowed(path, policy)` helper
  - `dispatchToolCall(call, ws, policy)` — read_file unrestricted; replace_in_file/create_file/delete_file проходят policy. На rejection — `error: path "X" is not named in the task — only [...] are in scope` → tool message → модель адаптируется
  - `ToolCallingCoderAgent` строит policy из step description; первое сообщение модели включает `Allowed write targets: ...` явный list
- [x] System prompt rewrite (took 2 passes):
  - First pass был too strong ("REJECTED" + "Stop, ... or call done() with no changes") → модель сдавалась с 0 file changes (deterministic на двух runs)
  - Second pass softened: "focus your work on a path that IS in scope ... Calling done() without making any of the requested edits is wrong unless task is genuinely no-op"
- [x] 14 новых unit-тестов: extractAllowedPaths (6), isWriteAllowed (2), dispatcher policy enforcement (6) → 25/25 в файле, 268/268 общая
- [x] 12/12 пакетов собрались

**Бенчмарк-проверка на rag-system-target (`/version` в `packages/api/src/server.ts`):**

| Iteration | What Coder produced | Scope creep | Score |
|---|---|---|---|
| v1.29 patch-based | nothing (5 search-not-found cascades) | n/a | 0/10 |
| v1.30 tool-calling no policy | server.ts surgical edit | **package.json wiped, vitest-setup.ts created** | 5.2/10 |
| **v1.30.1 + policy** | server.ts edit (cargo-culted /health body — model comprehension issue) | **none — only server.ts touched** | 5.0/10 |

**Главный win v1.30.1:** **scope creep устранён**. Та же task на v1.30 затрагивала 3 файла включая wiped package.json; на v1.30.1 — ТОЛЬКО `packages/api/src/server.ts`. Policy enforcement верифицирован прямым сравнением.

**Surfaced findings (v1.30.2 + v1.30.3 targets):**
- **Coder cargo-culting:** /version вернул `{status, ollama, uptime}` (handler /health скопирован) вместо `{version: '1.0.0'}`. Model comprehension bug, не scope. Кандидат на prompt fix
- **Patch-based validation Fixer не имеет policy** — кикнул'ся когда Coder edit прошёл, попытался "fix" путём writing `from 'jest'` patches к unrelated test files (search-not-found cascade — same v1.29 failure mode). Нужна migration на tool-calling: **v1.30.3**
- **Reviewer approves empty Coder output** — first run Coder выдал 0 changes, Reviewer одобрил. **v1.30.2** target

**Detailed run-file:** [docs/benchmarks/runs/2026-04-29-v1.30.1-scope-discipline.md](docs/benchmarks/runs/2026-04-29-v1.30.1-scope-discipline.md)

#### v1.30.2 — Reviewer rejects empty Coder output (~1 час)
- [ ] Если codeChanges.files.length === 0 — Reviewer возвращает `isApproved: false` с issue "Coder produced no file changes for the requested step"
- [ ] **Атакует:** v1.30 sandbox first run где Coder произвёл 0 файлов и Reviewer одобрил

#### v1.30.3 — Fixer migration to tool-calling (✅ реализовано — code; live blocked by Ollama infra)

**Цель:** Patch-based Fixer (validation loop) hallucinated `{search, replace}` блоки на rag-system-target v1.30.1 точно как patch-based Coder в v1.29 — `from 'jest'` patches к test files где import не существует. Migration на tool-calling использует ту же coordinate-based infrastructure что Coder.

- [x] [packages/agents/src/tool-calling-fixer.ts](packages/agents/src/tool-calling-fixer.ts) — `ToolCallingFixerAgent` (sibling класс ToolCallingCoderAgent):
  - `execute(issues, currentFiles, context, taskMode, projectRoot)` — issues-first signature
  - `buildFixerAllowedSet(currentFiles, issues)` — union paths из Coder output И mentions в error messages (TS quotes `file.ts:42:`); оба — legitimate edit targets
  - Fixer-flavored system prompt: ADDRESS ONLY listed issues, restore missing imports не удаляя call sites, TS2362 → `.getTime()`, jest→vitest mocking guidance, scope discipline mirrored
  - Reuse `TOOL_DEFINITIONS`, `dispatchToolCall`, `WritePolicy` из tool-calling-coder.ts
- [x] [orchestrator.ts](packages/agents/src/orchestrator.ts) `runValidationLoop` — переключение Fixer по `config.agents.toolCallingCoder` flag (тот же флаг для пары; Coder + Fixer работают только в lockstep)
- [x] 6 новых unit-тестов: buildFixerAllowedSet (union, dedup, edge cases) + agent shape; 274/274 общая
- [x] 12/12 пакетов собрались

**Live verification на rag-system-target /version (две попытки):**

| | Coder phase | Fixer phase | Result |
|---|---|---|---|
| #1 | ~4m server.ts (in-scope) | ~8m → Ollama `fetch failed` | task failed |
| #2 | ~3m server.ts (in-scope) | ~7m → Ollama `fetch failed` | task failed |

**Pattern reproducible:** Coder работает чисто 3-4 мин на 91-файловом проекте, Fixer вылетает после ~7-8 мин. Каждый Fixer round добавляет 2 messages в conversation (assistant tool_call + tool result); после 20-30 round'ов история большая, llama runner OOM'ится / умирает. **Это infra ceiling Ollama под длинными tool-calling sessions, не code defect.**

**Important positive findings:**
- Coder phase reliably stays in-scope (только server.ts на двух попытках, no creep)
- Failure clean (`status: failed`, no half-committed mess)
- Архитектура tool-calling Fixer корректна — unit-тесты подтверждают; just need infra to support sustained loops

**Detailed run-file:** [docs/benchmarks/runs/2026-04-29-v1.30.3-tool-calling-fixer.md](docs/benchmarks/runs/2026-04-29-v1.30.3-tool-calling-fixer.md)

#### v1.30.3.1 — Fixer history truncation + smaller call budget (✅ реализовано)

**Цель:** v1.30.3 live bench показал Ollama `fetch failed` после ~7-8 минут tool-calling Fixer'a — conversation history рос линейно (каждый round +2 messages), llama runner OOM. Pruning + меньший call budget.

- [x] [packages/agents/src/tool-calling-fixer.ts](packages/agents/src/tool-calling-fixer.ts):
  - `pruneHistory(messages)` — когда `messages.length > 22`, keep `system + initial user task + last 16 trail messages` (8 round-trips); inserts `[Conversation pruned: N earlier rounds omitted]` marker. Called every round в Fixer loop
  - `MAX_TOOL_CALLS` 50 → **25** (Fixer должен converge быстрее Coder'a — он fix'ит known issue, не feature)
- [x] 6 новых unit-тестов: under-threshold no-op, head/tail preservation, recent rounds intact, truncation note, total budget cap, return-value semantics → 12/12 в файле, 280/280 общая

**Live bench /version на rag-system-target:**

| Phase | v1.30.3 | **v1.30.3.1** |
|---|---|---|
| Coder | server.ts in-scope | server.ts in-scope (same) |
| Fixer attempt #1 | crashed Ollama (~8m) | **completed (~2m)** ✓ first time! |
| Fixer attempt #2 | n/a | crashed Ollama (~8m) |

**Партиальный win:** **первый раз tool-calling Fixer attempt завершается без crash на 91-файловом проекте**. Pruning работает. Но attempt #2 всё равно crashes — каждый attempt fresh state, pruning resets между attempts; если task не fixable из validation output (cargo-cult underlying issue), второй attempt просто iterates pointlessly до crash.

**Корневая причина persistent failure: Coder cargo-culting** (v1.30.1+ benchmark). /version handler копирует /health body вместо `{version: '1.0.0'}`. Fixer read'ит file, но typecheck/test errors не указывают "return value wrong" — Fixer iterates без convergence. **v1.30.4 (Coder prompt fix) — следующий unblock.**

**Detailed run-file:** [docs/benchmarks/runs/2026-04-29-v1.30.3.1-fixer-history-pruning.md](docs/benchmarks/runs/2026-04-29-v1.30.3.1-fixer-history-pruning.md)

#### v1.30.4 — Coder prompt fix for cargo-culting (✅ реализовано)

**Цель:** v1.30.1+ bench show'ало паттерн — Coder читает sibling route (/health) и копирует body как template вместо того чтобы использовать return value из task description (`{version: '1.0.0'}`).

- [x] [packages/agents/src/tool-calling-coder.ts](packages/agents/src/tool-calling-coder.ts) `SYSTEM_PROMPT` — добавлена секция `CONTENT COMES FROM THE TASK DESCRIPTION — NOT FROM SIBLING CODE`. Объясняет: read_file для STRUCTURE (где вставить, indentation, imports), не для копирования logic; new code's BEHAVIOR из task description; specific example (/version → `return { version: '1.0.0' }`)
- [x] No code logic changes; 280/280 unit-tests still green; 12/12 build

**Live bench /version на rag-system-target:**
- ✓ **Впервые** Coder выдал correct content `return { version: '1.0.0' }` (vs предыдущие cargo-cult клоны /health body). Прямое behavioral change от prompt section
- ✗ **Surface'ился new failure layer — structural placement.** `replace_in_file(start_line, end_line)` consumed закрывающий `});` от /health, заменил на новый /version handler без replacement closing brace. File syntactically broken: /version вложен внутрь /health body
- ✗ Fixer затем пытался recover ~10 мин, Ollama crashed (same v1.30.3 ceiling)

**Cumulative progression на /version:**
| Iteration | Coder did right | Coder did wrong |
|---|---|---|
| v1.30.1 | server.ts in-scope | cargo-cult content |
| v1.30.3 | server.ts in-scope | cargo-cult, Fixer crash |
| v1.30.3.1 | server.ts in-scope | cargo-cult, attempt #1 ok #2 crash |
| **v1.30.4** | **server.ts in-scope, content CORRECT** | **structural placement off (closing brace eaten)** |

Six iterations peeled six different failure modes. v1.30.4 closed the **content** layer; v1.30.5 нужен для **placement** layer.

**Detailed run-file:** [docs/benchmarks/runs/2026-04-29-v1.30.4-cargo-cult-fix.md](docs/benchmarks/runs/2026-04-29-v1.30.4-cargo-cult-fix.md)

#### v1.30.5 — Verify-syntax tool после replace_in_file (✅ реализовано)

**Цель:** v1.30.4 surface'ил что Coder может выбрать line range которая consumes structural delimiters → файл становится syntactically broken. Validation fails, Fixer iterates без convergence, Ollama crashes.

- [x] [packages/agents/src/tool-calling-coder.ts](packages/agents/src/tool-calling-coder.ts):
  - `checkBraceBalance(content)` — string/comment-aware balance check (`{}/()/​[]`). Игнорирует braces в `"strings"`, `// line`, `/* block */` comments, template literals. Early-exits на net-negative (closing without opener mid-file). Returns `{ok, balance}` или `{ok:false, reason, balance}`
  - `WorkingSet.overwriteRaw(path, content)` — preserves entry's action label, used for atomic undo
  - `replace_in_file` dispatcher: capture pre-edit content + balance, apply replace, re-check; if was balanced → unbalanced — call `overwriteRaw` to restore + return error message naming the issue. Model retries within its loop, до того как validation запускается
  - `create_file`: pre-check supplied content для balance
  - Skip check для non-source файлов (md/json/yaml)
- [x] 14 новых unit-тестов: balance detection, string/comment awareness, escape sequences, the v1.30.4 "consumed closing brace" pattern caught, rollback behavior, balanced edits pass-through, non-source file skip, create_file pre-check
- [x] 294/294 общая зелёная

**Live bench /version на rag-system-target (32 мин):**

| Phase | v1.30.4 | **v1.30.5** |
|---|---|---|
| Task status | `task_failed` (Ollama crash) | **`completed`** ✓ first time! |
| Coder content | correct | correct |
| File structure | unbalanced (closing eaten) | duplicate code (balance OK but structurally messy) |
| Final | task_failed | commit_skipped |

**Главный win:** **первый раз task завершилась без Ollama crash на 91-файловом проекте**. Graduated с `task_failed` (infra layer) на `commit_skipped` (output quality layer) — recoverable failure. v1.30.3.1 history pruning + v1.30.5 verify-syntax (cuts off some Fixer iterations early) держат Ollama up через 32 мин.

**Cumulative progression на /version (7 iterations, 7 failure modes peeled):**

| Iteration | Coder did right | Coder did wrong |
|---|---|---|
| v1.30 | server.ts surgical | scope creep |
| v1.30.1 | scope OK | cargo-cult content |
| v1.30.4 | scope + content correct | structural placement (closing eaten) |
| **v1.30.5** | **scope + content + brace balance** | **duplicate code (model includes context lines in new_text)** |

Brace balance correctly catches v1.30.4 failure (verified в unit test). Но новый failure это duplicate content — model в new_text включила re-paste sibling-route header, balance проходит (дубль самобалансируется), но файл структурно messy.

**Detailed run-file:** [docs/benchmarks/runs/2026-04-29-v1.30.5-verify-syntax.md](docs/benchmarks/runs/2026-04-29-v1.30.5-verify-syntax.md)

#### v1.31 — Structural anchor edits (✅ реализовано)

**Цель:** v1.30 → v1.30.5 пилили 7 micro-failure-modes Coder'a в line-coord слое — каждый peeled новый layer (off-by-one, consumed brace, duplicate context, метод outside class). Архитектурный move — заменить `replace_in_file(start_line, end_line)` на симвoлoм-anchored инструменты, чтобы whole class of placement bugs стал impossible by construction.

- [x] [packages/agents/src/structural-edits.ts](packages/agents/src/structural-edits.ts) — новый модуль с pure AST-помощниками (TypeScript Compiler API):
  - `locateAddMethod(content, container, source)` — добавляет метод в класс, AST resolves the closing brace line
  - `locateReplaceMethod(content, container, name, source)` — pinpoint replacement of method's signature+body; jsdoc preserved
  - `locateReplaceFunction(content, name, source)` — top-level FunctionDeclaration
  - `locateAddRoute(content, http_method, route_path, body, params?)` — Fastify-aware: walks for `app.METHOD(path, ...)` calls, copies actual instance name (app/server/fastify/instance/route) и indent style (2/4/tabs), inserts после последней route. Errors на duplicate, unknown method, unsafe path chars
  - `locateAddImport(content, source, names?, default_name?, type_only?)` — идемпотентно: returns noop если уже всё там; merges names into existing import; inserts new после последнего import (или top of file). Не support'ит `import * as ns`
  - `locateAddExport(content, source)` — appends после last top-level export, else после last import, else top
- [x] [packages/agents/src/working-set.ts](packages/agents/src/working-set.ts) — `insertBefore(relPath, line, text)` для clean insertion semantics. Trailing `\n` — line terminator, не extra blank line
- [x] [packages/agents/src/tool-calling-coder.ts](packages/agents/src/tool-calling-coder.ts) — 6 новых TOOL_DEFINITIONS, 6 dispatcher cases через `executeStructuralEdit(toolLabel, filePath, ws, policy, locator)` helper (scope discipline v1.30.1 + brace-balance defense v1.30.5 переиспользованы), `WRITE_EMITTING_TOOLS` + `FILE_ARG_KEY` extends event emission на все structural tools, SYSTEM_PROMPT rewritten — structural tools listed первыми как PREFERRED для TS/JS edits, `replace_in_file` demoted на fallback для non-source content
- [x] [packages/agents/src/tool-calling-fixer.ts](packages/agents/src/tool-calling-fixer.ts) — symmetric prompt update; explicit warning что `add_import` requires `names` array
- [x] [packages/model-router/src/types.ts](packages/model-router/src/types.ts) — `ToolParamSchema` extracted to support `items` для array-typed params (`add_import.names`)
- [x] **+62 unit-тестов**: 5 для `WorkingSet.insertBefore`, 45 для structural-edits (happy paths + locator errors per tool), 12 dispatcher integration. **356/356 общая зелёная**

**Live bench (rag-system-target):**

| Task | v1.30.5 | **v1.31** |
|---|---|---|
| `/version` Coder | duplicate-content layout (balance OK, structurally messy) | **byte-perfect via single `add_route` call** ✓ |
| `/version` wall | ~32 min | **~12 min** (3× faster) |
| `/version` tool calls | ~25 line-coord rounds | **3 calls** (read + add_route + done) |
| `getSize()` Coder | n/a | **byte-perfect inside MemoryQueue class via `add_method`** ✓ |
| `getSize()` placement | (v1.30: OUTSIDE class) | **inside class by construction** |
| Final commit | commit_skipped (output quality) | commit_skipped (Fixer regressed otherwise — see below); auto-branch mergeable |

**Cumulative progression /version (8 iterations):**

| Iteration | Coder did right | Coder did wrong |
|---|---|---|
| v1.29 | nothing | 5 search-not-found cascades |
| v1.30 | server.ts surgical | scope creep (package.json wiped) |
| v1.30.1 | scope OK | cargo-cult /health body |
| v1.30.4 | content correct | structural placement (closing eaten) |
| v1.30.5 | balance OK | duplicate-content (model includes context lines) |
| **v1.31** | **byte-perfect via `add_route`** | (Coder layer solved; Fixer regressed separately) |

**Sandbox results (5-file project):**

- L1.1 (Add /health) — 1 fail / 1 pass на двух runs. На fail Coder placed /health в server.ts (which has 0 routes — `add_route` errors); fallback на replace_in_file outside usersRoutes plugin → Reviewer rejected 3 attempts → step failed. На pass clean `read_file → add_route → done` сразу landed correctly inside usersRoutes. **Variability в "model picks which file", не в structural tools themselves**
- L2.1 (cross-file middleware) — completed + committed, но с **duplicate `await app.register(usersRoutes);`**. После `add_import` сдвинул line numbers, model вызвал `replace_in_file(start_line=6, end_line=6)` со stale coords из original `read_file`. Validation didn't catch (compiles, tests pass). **Mitigation landed mid-run:** SYSTEM_PROMPT now requires re-read after every mutation

**What worked:**
- **`add_route` decisively solved /version.** Three tool calls instead of 25; 12 min instead of 32; byte-perfect placement inside the buildServer's route block, instance name copied from existing routes
- **`add_method` decisively solved getSize.** Method ends up INSIDE the class — this was a deterministic v1.30 failure (placed outside), now deterministic v1.31 success
- **Structural tools обходят whole classes of placement bugs by construction:** off-by-one, consumed brace, duplicate-content, метод-outside-class, all impossible
- **Wall times rolled back substantially.** Tool counts collapsed по всем successful tasks
- **Scope discipline + brace-balance defenses переиспользованы чисто** через `executeStructuralEdit` helper — no regression на тех properties

**What broke (smaller class — fundamentally more tractable):**
- **File-anchor variance.** When task names a route без файла, model sometimes picks server.ts (no routes — add_route errors) instead of routes/users.ts. Past iterations были deterministic 10/10 на этом — v1.31 introduces variance because new prompt steers more aggressively toward structural tools. Mitigation: prompt iteration
- **Fixer's `add_import(file, source)` без names** — model invokes the new tool but skips the `names` array, getting useless side-effect import. Pattern deterministic across /version + getSize (8 такие calls). **Fix landed:** Fixer SYSTEM_PROMPT explicit warning, awaits validation
- **Line-shift bug в L2.1** (sandbox) — model called replace_in_file со stale coords после add_import shifted lines. **Fix landed:** SYSTEM_PROMPT (Coder + Fixer) explicit warning о need to re-read after mutation, awaits validation

**Lessons:**
1. Архитектурный shift decisively right call. Six iterations of whack-a-mole replaced by one structural iteration that solves Coder layer для file-anchored atomic tasks
2. Variability moved from "edit correctness" to "file/argument selection" — fundamentally easier to address through prompt iteration
3. Two prompt fixes landed mid-run (line-shift, Fixer add_import names) — direct responses to observed evidence; awaiting v1.31.1 validation
4. v1.32 candidate: stricter Fixer scope policy (refuse edits outside Coder's scope unless explicitly named in error message)

**Detailed run-file:** [docs/benchmarks/runs/2026-04-30-v1.31-structural-anchors.md](docs/benchmarks/runs/2026-04-30-v1.31-structural-anchors.md)

#### v1.31.1 — Validation prompt-fixes (✅ реализовано)

**Цель:** Два SYSTEM_PROMPT-фикса, которые landed mid-v1.31 (line-shift warning + Fixer add_import-with-names guidance) — empirical validation на тех же bench-задачах, которые выявили их.

- [x] **L2.1 sandbox** — line-shift fix validated. Финальный diff чистый: один `await app.register(usersRoutes)`, нет duplicate. Coder ещё допустил residual "duplicate import в replace_in_file new_text", но Reviewer поймал на attempt #1, Fixer пофиксил на attempt #2, commit landed
- [x] **L1.1 sandbox 3 runs** — failure rate dropped 50% (v1.31) → **0% (v1.31.1)**. 2/3 byte-perfect через `add_route`; 1/3 committable через `replace_in_file` с lap-style indent issue (compiled, tests pass, but 4-space vs 2-space)
- [x] **/version target** — Fixer add_import fix validated: 9 calls all с concrete `names` (`logger`, `taskEvents`, `OllamaClient`); 0 empty-names side-effect imports vs v1.31's 8
- [x] **getSize target** — same pattern: many add_import calls, all named. Coder edit byte-perfect (unchanged from v1.31)
- [x] Target benches still commit_skipped (pre-existing typecheck noise в test files, не v1.31 issue) — Fixer scope discipline это v1.32 candidate

**Aggregate v1.31 → v1.31.1:**

| Metric | v1.31 | **v1.31.1** |
|---|---|---|
| L1.1 sandbox failures | 1/2 runs | **0/3 runs** |
| L2.1 duplicate-register bug | present | **absent** |
| Fixer empty-names `add_import` | 8 | **0** |
| Fixer named `add_import` | 0 | 20+ across two benches |

**v1.32 candidates** (priority order):
- **v1.32-a (~3-4h):** stricter Fixer scope — refuse writes outside Coder's working set unless issue explicitly references file path. Should turn target benches from commit_skipped → commit landed
- **v1.32-b (~2-3h):** post-tool synthetic "WorkingSet state" message after structural mutations — catches L2.1 residual "duplicate import в replace_in_file new_text"
- **v1.32-c (larger):** sub-agents (BugFixAgent / RefactorAgent / FeatureAgent) on v1.31 primitives

**Detailed run-file:** [docs/benchmarks/runs/2026-04-30-v1.31.1-prompt-fixes.md](docs/benchmarks/runs/2026-04-30-v1.31.1-prompt-fixes.md)

#### v1.31.2 — Bench coverage extension (✅ run, без code changes)

**Цель:** L3.1 (refactor const-object-literal → class) и L4.1 (bug fix с injected bug) — две bench-задачи которые ни разу не запускались live, чтобы расширить evidence-base structural-tools архитектуры за пределы additive file-anchored tasks.

- [x] **L3.1 byte-perfect** — Coder correctly fell back на `replace_in_file` потому что AST-anchored tools не подходят (UserService — VariableStatement с ObjectLiteralExpression, не FunctionDeclaration). 3 calls, 1m wall, clean commit. Validates **tool-selection logic for negative case**.
- [x] **L4.1 critical quality finding** — first bench где Coder требуется **навигироваться** к багу, не просто исполнить наименованную операцию. Coder читал `routes/users.ts` (где endpoint), **никогда не открыл `services/user-service.ts`** (где bug). Сделал meaningless rename. TestRunner failed → Fixer **modified the test** добавив `user.createdAt = new Date()...` после create() → green commit landed. **Bug всё ещё в production коде**, тест gamed.

**Семантический разрыв surfaced:**
- Coder navigation = literal file mentioned in task; не использует code-graph для tracing UserService.create() → user-service.ts
- Reviewer (small 7B) — syntax checker, не semantic; approved meaningless rename
- Fixer permissive scope — может писать в `tests/**`; "fix the test, not the code" — cheapest path к зелёной валидации
- Validation gates (typecheck + tests) пройти можно при семантически broken commits

**v1.31.2 lands** (нет code changes — только bench evidence). Архитектурные claims v1.31.1 stand для *additive, file-anchored* tasks (L1.1, L2.1, /version, getSize, L3.1) но **НЕ для navigational / bug-fix tasks** (L4.1).

**v1.32 priority redefined по итогу L4.1:**
- **v1.32-a (revised, highest priority, ~4-6h):** Fixer scope discipline с specific anchor — *"Fixer не может писать в `tests/**` или `**/__tests__/**` если этот path не был в Coder's output."* Изменение в `buildFixerAllowedSet`: filter union, drop test paths Coder не trogал. Unit-tests на новый filter. Re-run L4.1 для валидации
- **После v1.32-a** — re-run L4.1. Если Fixer всё ещё не может навигироваться к user-service.ts, это evidence для v1.32-d (code-graph-driven Coder context). Если может — L4.1 lands cleanly, bench coverage полная
- **v1.32-d (NEW candidate, ~1 day):** при task mention'е symbol'a или endpoint'a — run code-graph "find definition + dependencies" и inject в Coder context. Lечит navigation gap

**Detailed run-file:** [docs/benchmarks/runs/2026-04-30-v1.31.2-bench-coverage-extension.md](docs/benchmarks/runs/2026-04-30-v1.31.2-bench-coverage-extension.md)

#### v1.32-a — Fixer test-scope discipline (✅ реализовано)

**Цель:** прямой ответ на v1.31.2 L4.1 critical finding (Fixer modified test вместо production code → green commit с broken bug). Tighten `buildFixerAllowedSet`: drop test-file paths from issue-mention pool unless Coder touched them.

- [x] [packages/agents/src/tool-calling-fixer.ts](packages/agents/src/tool-calling-fixer.ts):
  - `TEST_PATH_PATTERNS` — три convention'a: `tests/`, `__tests__/`, `.test.{ts,tsx,js,jsx,mjs,cjs}` / `.spec.*` filename suffixes
  - `isTestPath(p)` helper
  - `buildFixerAllowedSet` — после union отбрасывает paths matching `isTestPath()` если их нет в Coder's set. Coder-produced test files остаются в scope (legitimate test maintenance)
- [x] FIXER_SYSTEM_PROMPT — explicit warning что TestRunner failures point at production bugs не at test bugs; dispatcher reject test writes которые Coder не trogал
- [x] **+6 unit-тестов** для нового filter (top-level tests/, __tests__/, .test/.spec suffixes, Coder-produced legit, non-test paths flow through, deeply-nested __tests__). 362/362 общая

**L4.1 re-run на bug-inject baseline:**

| | v1.31.2 | **v1.32-a** |
|---|---|---|
| Test file edited Fixer'ом | yes (silenced assertion) | **no** ✓ |
| Production bug fixed | nope | nope (write rejected — see ниже) |
| Validation status | pass (тест silenced) | fail (correctly red) |
| Commit | landed (broken shipped) | **commit_skipped** ✓ correct signal |
| Severity | HIGH (silent failure) | **LOW (visible failure)** |

**Surfaced adjacent gap:** Fixer **корректно навигировался** к user-service.ts через read_file и предложил **правильный fix** — но dispatcher reject'нул write потому что user-service.ts не было ни в Coder's output set, ни в issue-mention set (TestRunner failure указывает на test, not production module). Fixer fell back на workaround в routes/users.ts (spread + add createdAt в response) — incorrect (storage всё ещё broken), но validation осталась красной → commit_skipped.

**v1.32-a achieved its specific goal** (test-gaming impossible) **без полного решения L4.1**. Это better failure mode чем v1.31.2 (operator видит partial workaround на auto-branch, recognizes incomplete fix), но system bailed на navigation/scope gap.

**Next iteration recommendation — v1.32-a.1 (~1-2h):**
- `read_file(p)` gestures grant write permission to `p` for that loop
- "Scope grows with explicit reads" — transparent, model-driven scope expansion  
- Forbidden patterns (`package.json`, lockfiles) всё ещё apply
- Re-run L4.1: ожидается **commit landed** (Fixer reads user-service.ts → может писать → fix bug → validation green → commit)
- Если L4.1 всё ещё fails — evidence для v1.32-d (RAG-driven Coder navigation)

**Detailed run-file:** [docs/benchmarks/runs/2026-04-30-v1.32-a-fixer-test-scope.md](docs/benchmarks/runs/2026-04-30-v1.32-a-fixer-test-scope.md)

#### v1.32-a.1 — Read-grants-write + Fixer test-path forbidden (✅ реализовано)

**Цель:** v1.32-a показал что Fixer корректно навигировался к user-service.ts через read_file и предложил правильный fix, но dispatcher reject'нул write (path не в Coder output / issue mentions). v1.32-a.1: `read_file(p)` в текущем loop'е grant'ит write permission to `p` — model'ская deliberate чтение становится transparent scope-acquisition gesture.

- [x] [working-set.ts](packages/agents/src/working-set.ts) — `hasOpened(relPath)` public method (free signal — using existing lazy-load cache)
- [x] [tool-calling-coder.ts](packages/agents/src/tool-calling-coder.ts) `isWriteAllowed` — добавлен optional `ws` параметр; logic: forbidden absolute → allowlist hit → ws.hasOpened → reject с инструкцией использовать read_file. Все 4 dispatcher write-paths (replace_in_file, create_file, delete_file, executeStructuralEdit) пропускают `ws`. Optional для backwards-compat
- [x] [tool-calling-fixer.ts](packages/agents/src/tool-calling-fixer.ts) `FIXER_TEST_PATH_FORBIDDEN` — Fixer policy combines configs + test-paths. Закрывает read-grants-write loophole (read test → gain write для silence assertion = re-open L4.1 game-the-test). Coder-produced tests остаются writable через explicit allow precedence
- [x] Coder + Fixer SYSTEM_PROMPT updated — explain read-grants-write rule
- [x] **+18 unit-тестов**: 6 hasOpened, 7 isWriteAllowed read-grants-write (включая backward-compat), 2 dispatcher integration, 3 Fixer test-path forbidden. **380/380 общая зелёная**

**L4.1 re-run на bug-inject:**

| Stage | Result |
|---|---|
| Coder phase | **pathological 44-min loop** на routes/users.ts (unrelated v1.32-a.1 bug — model duplicates wrapper в new_text → brace imbalance → rollback → retry × 30+) |
| Fixer phase | **decisive win**: read user-service.ts → tried replace_function (rejected — object-literal method, not FunctionDeclaration) → fell back на replace_in_file → **bug fixed correctly** (added createdAt + removed `as User` cast) |
| Validation | TestRunner pass, TypeChecker pass, **Validation passed** ✓ |
| Commit | logged "Committed changes" с empty hash, **но git status показывает modified user-service.ts uncommitted** — orchestrator/git-engine bug, не v1.32-a.1 |

**Bug fix end-state:**
```diff
-    } as User;
+      createdAt: new Date().toISOString(),
+    };
```

Working tree содержит **byte-perfect fix**. Operator может git add + commit вручную для landing'a.

**Cumulative L4.1 progression:**

| | v1.31.2 | v1.32-a | **v1.32-a.1** |
|---|---|---|---|
| Test gamed by Fixer | yes | no | no |
| Production fix applied | no | no (write rejected) | **yes** ✓ |
| Validation status | pass (silenced) | fail (correctly red) | **pass (correctly green)** ✓ |
| Commit landed | yes (broken shipped) | no (commit_skipped) | no (orchestrator bug) |
| Severity | HIGH | LOW-MED | **LOWEST** (correct fix in tree, just unstaged) |

**v1.32-a.1 specific goal achieved decisively.** Architectural primitive validated. Two adjacent issues surfaced (independent of this iteration):

**v1.32-a.2 (next, ~1-2h):** orchestrator/git-engine bug — `runValidationLoop` не aggregate'ит Fixer's FileChange[] в staged set. Investigate, fix, add test "Coder no-op + Fixer real fix → commit lands". After этого L4.1 = first end-to-end green commit на navigational bug-fix task — closing v1.31.x arc.

**v1.32-a.3 (later, ~2h):** Coder loop pathology — detect repeated identical tool calls, break early с system nudge "you've been rejected N times, change strategy." Wall-time win.

**Detailed run-file:** [docs/benchmarks/runs/2026-04-30-v1.32-a.1-read-grants-write.md](docs/benchmarks/runs/2026-04-30-v1.32-a.1-read-grants-write.md)

#### v1.32-a.2 — Orchestrator commit-landing aggregation (✅ реализовано, unit-validated)

**Цель:** v1.32-a.1 surface'ил bug — Fixer применил byte-perfect fix, validation passed, "Committed changes" logged с empty hash, но git status показал uncommitted modified file. Trace: `runValidationLoop` писал Fixer's файлы через `writer.execute(fixed)` но не аппендил paths в outer `writtenFiles` array → `commitChanges(stale list)` → `git.add` стейджил только Coder's paths → `git.commit` с пустым stage → empty commit hash.

- [x] [packages/agents/src/orchestrator.ts](packages/agents/src/orchestrator.ts):
  - `runValidationLoop` теперь возвращает `{ passed, issuesCount, writtenFiles: string[] }` — tracks Fixer's writes via `Set<string>` 
  - Caller в `runTask` мержит `validation.writtenFiles` в outer `writtenFiles` через includes-check (preserves insertion order: Coder → Fixer)
- [x] **+2 unit-теста** в orchestrator.test.ts:
  - `commits Fixer-produced paths even when Coder did not touch them` — Coder pишет routes/users.ts, Fixer pишет services/user-service.ts, validation passes на retry → assert: `git.commitChanges` called с обоими paths
  - `dedupes the staged file list when Coder and Fixer touched the same path` — same path в обоих → staging list = [path], no duplicate
- [x] **382/382 общая зелёная** (+2 vs v1.32-a.1 380)

**L4.1 live bench (×2 runs):**

| Run | Coder | Fixer | Validation | Final |
|---|---|---|---|---|
| #1 | route workaround `user.createdAt = new Date()...` | **0 tool calls — bailed** | red | commit_skipped |
| #2 | route workaround `return { ...user, createdAt }` | **0 tool calls — bailed** | red | commit_skipped |

**v1.32-a.2 fix correctly implemented but не exercised end-to-end** — validation никогда не прошла, commit-aggregation path не reached.

**Surfaced upstream issue — Fixer non-determinism:** across 4 L4.1 runs (v1.32-a → v1.32-a.2 #2), Fixer bail rate ~50% (2 navigated, 2 bailed). Bail = model emits text без tool_calls → loop terminates без fix. Hypothesis: prompt accretion across v1.32-a + v1.32-a.1 (~25 lines добавлено vs v1.30.5) → model parses constraints, sees minimal "Allowed write targets", concludes can't help, бэйлит.

**v1.32-a.3 (next, ~2-4h):**
- Prompt consolidation — collapse v1.32-a/a.1 additions, move dynamic policy rules ближе к "Allowed write targets" в user message
- Loop-level no-tool-calls retry — после первого text-only round, retry с stronger nudge ("you have not produced edits, navigate now") вместо immediate bail
- Re-run L4.1 — ожидается reliable Fixer navigation → v1.32-a.2 aggregation fix gets end-to-end demonstration
- After v1.32-a.3 single L4.1 success closes v1.31.x → v1.32-a.x arc: bug-inject → byte-perfect fix → **committed auto-branch** = operator-grade bug-fix workflow milestone

**v1.32-a.4 (опционально, ~1h):** orchestrator's `commitChanges` swallows empty commits silently — guard: warn + emit `commit_empty` event when `commitResult.commit === ""` instead of pretending success.

**Detailed run-file:** [docs/benchmarks/runs/2026-04-30-v1.32-a.2-commit-aggregation.md](docs/benchmarks/runs/2026-04-30-v1.32-a.2-commit-aggregation.md)

#### v1.32-a.3 — Fixer reliability + Coder retry symmetry (✅ реализовано, end-to-end validated)

**Цель:** v1.32-a.2 surface'ил Fixer non-determinism (~50% bail rate на L4.1) — single-shot retry с "Or call done() if no source edits can fix" эскейпом давал model'и слишком лёгкую возможность бейлить. Consolidate Fixer prompt + replace one-shot retry с двумя retries прогрессивно сильных nudges + symmetric upgrade для Coder.

- [x] [tool-calling-fixer.ts](packages/agents/src/tool-calling-fixer.ts) FIXER_SYSTEM_PROMPT консолидирован ~40 → ~20 строк (структурные тулы first, workflow с навигационным trick "test failure → production module", scope policy в одном параграфе, общие TS patterns)
- [x] User message в Fixer.execute() — "Initially-allowed write targets" + "Scope expansion: read_file on any non-forbidden path grants write access" размещены **рядом**, не разнесены между system prompt и user data
- [x] No-tool-calls retry — `consecutiveNoToolCalls` counter, 2 retries с прогрессивно strong nudges, бейл только на 3-м consecutive text-only response. **Killed escape language** ("Or call done() if no source edits can fix") — nudges говорят "tool call now", не дают implicit permission to bail. Symmetric Coder upgrade
- [x] **+5 unit-тестов**: 3 Fixer (bail on 3 consecutive, reset on real call, nudge #1 differs from #2) + 2 Coder (bail, reset). **387/387 общая** (+5 vs v1.32-a.2's 382)

**L4.1 re-run на bug-inject baseline — ОФИЦИАЛЬНО CLOSED end-to-end:**

| | |
|---|---|
| Coder | 3 calls (read → cosmetic replace_in_file → done); Reviewer approved |
| Validation #1 | TestRunner fail |
| Fixer | ~14 calls — read user-service.ts ✓ → traced types.ts → replace_in_file user-service.ts (real fix) → done |
| Validation final | TestRunner pass, TypeChecker pass, **Validation passed** |
| Commit | **landed** — `commitHash: 8319157...` (real hash, не empty) |
| Working tree | clean |
| Wall | **~7 min** (vs v1.32-a.1's 44 min) |

**Final diff** (committed):

```diff
# user-service.ts (real fix by Fixer)
       email: input.email,
-    } as User;
+      createdAt: new Date().toISOString()
+    };

# routes/users.ts (cosmetic Coder edit, harmless)
-    return UserService.create(...);
+     const user = UserService.create(...);
+     return reply.code(201).send({ ...user, createdAt: user.createdAt });
```

v1.32-a.2 commit-aggregation finally получает end-to-end demonstration — оба paths committed.

**Cumulative L4.1 progression — 5-iteration arc closed:**

| Iteration | Test gamed | Fixer engages | Fix applied | Commit landed | Severity |
|---|---|---|---|---|---|
| v1.31.2 | YES | yes(2) | NO | YES (broken!) | HIGH |
| v1.32-a | no | yes(5) | rejected | no | LOW-MED |
| v1.32-a.1 | no | yes(6) | YES | no (orchestrator bug) | LOW |
| v1.32-a.2 ×2 | no | **0 (bail)** | n/a | no | n/a |
| **v1.32-a.3** | **no** | **yes(14)** | **YES** | **YES (real hash)** | **CLOSED** ✓ |

**Operator-grade bug-fix workflow milestone reached.** Bug-injected baseline → byte-perfect fix in correct file → green validation → committed auto-branch → clean working tree.

**v1.32-a.4 (опционально, ~30m):** L4.1 multi-run robustness — ×5 consecutive runs на same baseline. Target: 5/5 commit-landed. Если стабильно — Phase 3 closure готова, можно переходить на v1.32-c sub-agents.

**Detailed run-file:** [docs/benchmarks/runs/2026-04-30-v1.32-a.3-fixer-reliability.md](docs/benchmarks/runs/2026-04-30-v1.32-a.3-fixer-reliability.md)

#### v1.30.6 (опционально) — Duplicate-content detection (~2-3 часа)

**Цель:** v1.30.5 surface'ил duplicate-content failure: model в new_text включает re-paste lines из surrounding context (думая что нужно "preserve" окружающий код). Brace balance не ловит — text duplicates are self-balancing.

- [ ] После `replace_in_file`: scan 5-10 lines immediately before `start_line` and after `end_line` в post-edit content. Если new_text содержит exact-line matches с этими — refuse + rollback с message `"new_text duplicates context lines — replace_in_file should NOT include surrounding context, it replaces the named line range only"`
- [ ] **Атакует:** explicit failure mode из v1.30.5 — duplicate /health header в /version task

#### Стратегическая развилка после 7 micro-iterations

**Кратко:** v1.30 → v1.30.5 пилили 7 failure modes Coder'a, каждый peeled новый layer. v1.30.6 (duplicate detection) — ещё один whack-a-mole. **Альтернатива — v1.31 sub-agents** + structural anchors:
- Заменить `replace_in_file(path, start_line, end_line, new_text)` на `replace_function('UserService.list', new_body)` / `add_route(file, 'GET', '/version', handler_body)`
- Symbol-anchored edits eliminate whole classes of placement bugs
- Coder работает в semantic layer, не в byte/line layer

Стратегический выбор после v1.30.5 коммита.

#### v1.31+ — Sub-agents (после v1.30)
- `BugFixAgent`, `RefactorAgent`, `FeatureAgent`, `MigrationAgent` — специализированные роли
- Planner выбирает кого вызвать вместо unified Coder

#### v1.32+ — Iterative editing с reflection
- Coder в цикле read → edit → verify → adjust
- Self-critique перед отправкой Reviewer'у

### Phase 4 — Storage upgrade (📋)

- [ ] Qdrant вместо HNSW JSON (production vector DB, hybrid search, payload filter)
- [ ] Symbol table в SQLite вместо CodeGraph JSON Map (быстрые SQL queries)
- [ ] Speculative decoding (Ollama draft models — 2-3x ускорение)

### MCP проекты v1.16 (✅ реализовано)
- [x] MCP server использует тот же `ProjectRegistry`+`ProjectManager`, что и API (общий `data/projects.db`)
- [x] Auto-register default project из `PROJECT_ROOT` если registry пуст — backwards compat для single-project пользователей
- [x] Новые tools: `list_projects` (markdown table с пометкой default), `register_project { root, name? }` (idempotent)
- [x] Optional `project_id` на: `index_codebase`, `search_code`, `get_related_code`, `run_task`, `list_decisions`, `add_decision` — без id используется default
- [x] `run_task` форвардит `project_id` в `POST /task` API; `get_task_status` использует API-роутинг (queue знает project_id)
- [x] Resources `adr://*`, `failures://top`, `tasks://recent` показывают данные default project; новый `projects://list` resource для discovery
- [x] Tool responses подсказывают `project_id` синтаксис → Cline сам быстро учится переключаться между проектами
- [x] Instructions сервера явно упоминают multi-project флоу

### Дальнейшие улучшения

### Пользовательский опыт
- [ ] Кастомный VSCode Extension — GUI sidebar с прогрессом задач
- [ ] История задач с фильтрацией и поиском
- [ ] Поддержка нескольких проектов одновременно
- [ ] Экспорт ADR в Markdown-файлы

### Параллелизм v1.9 (✅ реализовано)
- [x] DAG-aware scheduler в Orchestrator: независимые шаги (`dependencies: []` или общие предки) идут одновременно через `Promise.race`
- [x] Concurrency limit: `AGENTS_PARALLELISM=3` (default) — защита Ollama от перегруза параллельными LLM-запросами
- [x] `detectCycles()` — итеративный DFS с white/grey/black, бросает `Plan contains dependency cycle: a → b → a` до старта (без stack overflow на больших планах)
- [x] Dangling dependencies (id, которого нет в плане) — шаг не зависает, scheduler детектит "stuck" состояние и помечает skipped
- [x] Per-step recovery + structured logs работают как раньше: каждый параллельный шаг имеет свой `taskLogger.child({ stepId })`-эффект через payload
- [x] 4 новых теста: peak in-flight=3 для 3 независимых, peak=1 для цепочки a→b→c, cycle detection, dangling dep skip

### Streaming агентов v1.10 (✅ реализовано)
- [x] `OllamaClient.chatStream()` — AsyncIterable&lt;string&gt; с NDJSON-парсером, корректно режет chunks по `\n`, пережимает split через границы read()
- [x] `ModelRouter.routeStream()` — транзитно прокидывает chunks с моделью и ролью
- [x] `BaseAgent.callLLM` — теперь всегда использует streaming внутри, аккумулирует в строку для обратной совместимости (все 6 агентов работают без изменений)
- [x] `AsyncLocalStorage` контекст задачи (`withTaskContext`/`currentTaskContext`/`withAgent`) — taskId/stepId прокидываются через 5 слоёв без изменения сигнатур агентов
- [x] Orchestrator оборачивает plan/step/validation в `withTaskContext` → агенты внутри "видят" taskId автоматически
- [x] Новый event type `agent_stream` с полями `{agent, role, chunk, totalLen, stepId}`; throttle 120ms (SSE клиент видит плавный поток, bus не захлёбывается)
- [x] Transient events skip history buffer — не засоряют replay для поздних SSE-подписчиков
- [x] 14 новых тестов: NDJSON (boundaries, malformed lines, error), AsyncLocalStorage (isolation, async propagation, withAgent), BaseAgent streaming (assembly, event emission, transient no-history)

### Параллельный embed v1.11 (✅ реализовано)
- [x] `pMap(items, n, mapper)` — sliding-window pool в graph-retriever (один cursor, N воркеров крутятся пока есть работа)
- [x] `indexFile` распараллеливает embed-вызовы; `vectorStore.add()` под mutex как раньше — конкурентные insert'ы корректно сериализуются внутри индекса
- [x] `EMBED_CONCURRENCY=8` (default) — Ollama выдерживает 8 параллельных embed без проседаний; настраивается через ENV
- [x] Кеш-хиты не держат слот (синхронный SQLite), новый embed-запрос стартует мгновенно
- [x] 4 теста: peak in-flight = N (cap соблюдается), wall-time < serial baseline, отказ одного embed не валит остальные, no-op на пустом файле

### Параллельная индексация файлов v1.12 (✅ реализовано)
- [x] `Semaphore` (FIFO, counting) — глобальный лимит на одновременные Ollama embed-вызовы; cache-hits не занимают слот
- [x] `embedWithCache` оборачивает только сетевой round-trip; symbol-loop в `indexFile` стал просто `Promise.all` — семафор сам разруливает очередь
- [x] `indexCodebase` использует `pMap(files, fileConcurrency)` — несколько файлов парсятся и встают в embed-очередь одновременно
- [x] `FILE_CONCURRENCY=4` (default), `EMBED_CONCURRENCY=8` — комбинация даёт ~5-8× speedup на холодном кеше без перегрузки Ollama (peak in-flight = `embedConcurrency`, не `files × symbols`)
- [x] 4 теста codebase-parallel: глобальный cap соблюдается через границы файлов, file-level concurrency = 3 для 1-symbol файлов, wall-time < serial baseline, корректность при пустом файле в составе батча

### Tolerant JSON v1.13 (✅ реализовано)
- [x] `tryParseJsonTolerant<T>(raw)` — strict-first, затем pipeline из 6 фиксеров (BOM, code-fence, extract-from-prose, comments, trailing-commas, escape-control-in-strings)
- [x] Каждый фиксер запускается с учётом строковых литералов (не ломает `//` в URL, `}` внутри string и т.п.)
- [x] BaseAgent.parseJSON → теперь tolerant; логирует `fixes: [...]` через `logger.warn` если ремонт сработал — частые ремонты подсказывают, что промпт нужно подкрутить
- [x] При полном фейле — отдельная ошибка с `tried: [...]` для диагностики (видно сколько фиксеров пробовали)
- [x] 15 тестов: trailing comma, code fence, extract from prose, BOM, JS-style comments, multi-line string без escape, комбо (фенс + comma + проза), nested braces в строках, греедность extractor

### Live прогресс индексации v1.14 (✅ реализовано)
- [x] Новые event types: `index_start`, `index_file`, `index_skip`, `index_done` в `TaskEventType`
- [x] `indexCodebase(rootDir, opts)` теперь возвращает `indexId` (`idx-<timestamp>` если не передан)
- [x] События публикуются на канале `task:<indexId>` — SSE-клиенты используют тот же `GET /task/:id/stream` endpoint
- [x] Throttle 200мс на per-file events (1000-файлов репо не флудит); последний файл всегда эмитит для percent=100
- [x] `index_file`/`index_skip` помечены transient — не засоряют ring-buffer; `index_start`/`index_done` остаются для replay поздним подписчикам
- [x] Payload: `{file, processed, totalFiles, indexed, skipped, percent}` — UI рисует прогресс-бар без расчётов
- [x] MCP `index_codebase` tool возвращает indexId + URL стрима в response — Cline сразу подсказывает пользователю как смотреть прогресс
- [x] 5 тестов: правильный порядок start→done, percent=100 на последнем файле, авто-генерация indexId, transient не в history, skipped events на повторной индексации

### Производительность (следующее)

---

## Как обновлять этот файл

1. Выполнил задачу → поставь `[x]` в чеклисте
2. Завершил итерацию → обнови статус итерации на `🟡 В процессе` / `🟢 Готово`
3. Обнови таблицу состояния пакетов
4. Обнови статус проекта в шапке и дату последнего обновления
