# ROADMAP — RAG System

> Живой документ разработки. Обновлять по мере выполнения задач: менять `[ ]` на `[x]`, обновлять статусы пакетов и дату.

**Статус проекта**: 🟢 v1.28 — silent partial completion events; 219/219 unit-тестов; partial state теперь surfaced через `commit_partial` SSE event и поля `partial`/`failedStepIds`/`unrecoveredWrites` в `done.data`  
**Последнее обновление**: 2026-04-29  
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

#### v1.27 — Per-agent context tailoring (~1 день)
- [ ] Reviewer получает diff, не full files
- [ ] Planner получает tree + signatures, не full source
- [ ] Architect видит step description + conventions only
- [ ] Coder/Fixer/Tester — как сейчас (full context)
- [ ] **Атакует:** прожорливость промптов, ускоряет каждый шаг на 30-50%

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

### Phase 3 — Architecture (📋 после Phase 2)

#### v1.30+ — Tool-calling Coder
- Заменить JSON output на tool-calling: `read_file()`, `replace_in_file()`, `run_test()`
- Архитектурное решение для класса destruction'ов (модель не "пишет файл", а вызывает операции)
- Большая переделка (~3-5 дней)

#### v1.31+ — Sub-agents
- `BugFixAgent`, `RefactorAgent`, `FeatureAgent` — специализированные роли
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
