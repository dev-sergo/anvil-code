# ROADMAP — RAG System

> Живой документ разработки. Обновлять по мере выполнения задач: менять `[ ]` на `[x]`, обновлять статусы пакетов и дату.

**Статус проекта**: 🟢 v1.18 работает (VSCode extension: GUI sidebar с проектами, задачами и live SSE)  
**Последнее обновление**: 2026-04-23  
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
