# 🧠 RAG System — Autonomous Software Engineering Platform

> Полностью локальная автономная система программной инженерии.  
> Принимает задачу → планирует архитектуру → пишет код → тестирует → коммитит в git.

```
┌─────────────────────────────────────────────────────────────────┐
│                        HTTP API (Fastify)                       │
│                   POST /task  ·  GET /task/:id                  │
└─────────────────────┬───────────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────────┐
│                     Job System (Queue + Worker)                 │
│              In-memory queue · Retry · Status tracking          │
└─────────────────────┬───────────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────────┐
│                     Orchestrator Agent                          │
│               Управляет полным жизненным циклом задачи          │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ Planner  │→ │ Architect│→ │  Coder   │→ │  Tester  │       │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │
│                                    ↓ (fail)                     │
│                              ┌──────────┐                       │
│                              │  Fixer   │→ retry (max 3x)      │
│                              └──────────┘                       │
└──────┬──────────┬──────────┬──────────────┬─────────────────────┘
       │          │          │              │
  ┌────▼───┐ ┌───▼────┐ ┌───▼───┐   ┌─────▼─────┐
  │  RAG   │ │ Code   │ │ Safe  │   │    Git    │
  │ Engine │ │ Graph  │ │ Exec  │   │  Engine   │
  └────┬───┘ └───┬────┘ └───┬───┘   └─────┬─────┘
       │         │          │              │
  ┌────▼───┐ ┌───▼────┐ ┌───▼───┐   ┌─────▼─────┐
  │Vectors │ │  AST   │ │Backup │   │ Branches  │
  │(HNSW)  │ │ Parse  │ │ Diff  │   │  Commits  │
  └────────┘ └────────┘ └───────┘   └───────────┘
                 │
           ┌─────▼──────┐
           │   Memory   │
           │  (SQLite)  │
           └────────────┘
```

---

## 📋 Оглавление

- [Архитектура](#архитектура)
- [Структура проекта](#структура-проекта)
- [Описание пакетов](#описание-пакетов)
- [Требования](#требования)
- [Установка и запуск](#установка-и-запуск)
- [Конфигурация](#конфигурация)
- [API Reference](#api-reference)
- [Интеграция с VSCode](#интеграция-с-vscode)
- [Известные ограничения и план доработок](#известные-ограничения-и-план-доработок)

---

## Архитектура

Система построена как **Turborepo-монорепозиторий** из 10 независимых пакетов.  
Каждый пакет — отдельный npm workspace с собственным `package.json` и `tsconfig.json`.

### Принцип работы

1. Пользователь отправляет `POST /task` с описанием задачи
2. **Job System** ставит задачу в очередь, присваивает ID
3. **Worker** забирает задачу и передаёт в **Orchestrator**
4. Orchestrator последовательно запускает агентов:
   - **Planner** → декомпозиция задачи в DAG шагов
   - **Coder** → генерация кода для каждого шага
   - Все файловые операции проходят через **Safe Exec** (backup + diff + validation)
5. Результат коммитится через **Git Engine** в отдельную ветку
6. Статус и история сохраняются в **Memory** (SQLite)

### Модель маршрутизации LLM

```
Agent Role    → Model Size → Default Model
─────────────────────────────────────────────
planner       → small      → qwen2.5-coder:7b
reviewer      → small      → qwen2.5-coder:7b
tester        → small      → qwen2.5-coder:7b
architect     → large      → deepseek-coder-v2:16b
coder         → large      → deepseek-coder-v2:16b
fixer         → large      → deepseek-coder-v2:16b
```

Режим задачи (`fast`/`balanced`/`deep`) может форсировать все агенты на одну модель.

---

## Структура проекта

```
rag-system/
├── package.json              # Root workspace config
├── tsconfig.base.json        # Общая конфигурация TypeScript
├── turbo.json                # Turborepo pipeline
├── .env.example              # Шаблон переменных окружения
├── .gitignore
│
├── packages/
│   ├── shared/               # Общие типы, логгер, утилиты
│   ├── model-router/         # Маршрутизация LLM-запросов через Ollama
│   ├── memory/               # Персистентное хранилище (SQLite)
│   ├── safe-exec/            # Безопасные файловые операции
│   ├── git-engine/           # Git-операции (ветки, коммиты)
│   ├── code-graph/           # AST-парсинг и граф зависимостей
│   ├── rag/                  # Векторный поиск + графовый retrieval
│   ├── agents/               # Агенты (Planner, Coder, Orchestrator)
│   ├── job-system/           # Очередь задач + Worker
│   └── api/                  # HTTP API (Fastify)
│
└── data/                     # Runtime данные (gitignored)
    ├── memory.db             # SQLite база
    ├── vectors/              # HNSW индексы
    ├── backups/              # Бэкапы файлов перед перезаписью
    └── graphs/               # Сериализованные графы кода
```

---

## Описание пакетов

### `@rag-system/shared`
Фундаментальный пакет. Содержит:
- **Типы**: `TaskDefinition`, `AgentMessage`, `FileChange`, `DiffResult`, `JobStatus`, `ModelRole`
- **Логгер**: обёртка над `pino` с pretty-print, уровень задаётся через `LOG_LEVEL`

Используется всеми остальными пакетами.

### `@rag-system/model-router`
Абстракция над Ollama API. Компоненты:
- **OllamaClient** — HTTP-клиент к `POST /api/generate` и `/api/embeddings`
- **ModelRouter** — маппинг `AgentRole → Model`, кеширование, поддержка `jsonMode`
- **RoleOptimalSize** — таблица соответствия роли агента и размера модели

### `@rag-system/memory`
SQLite-хранилище через `better-sqlite3`. Три таблицы:
- `tasks` — история задач (id, description, status, result)
- `adr` — Architectural Decision Records (решения, контекст, последствия)
- `failures` — паттерны ошибок с частотой и резолюцией

### `@rag-system/safe-exec`
Пайплайн безопасной записи файлов:
1. **BackupManager** — создаёт копию файла в `data/backups/` перед перезаписью
2. **DiffEngine** — генерирует unified diff через библиотеку `diff`
3. **SafeWriter** — единственная точка записи; валидирует path (no traversal), создаёт backup, генерирует diff, поддерживает dry-run

### `@rag-system/git-engine`
Обёртка над `simple-git`:
- `createBranchForTask(taskId)` — создаёт ветку `auto/task-{id}-{timestamp}`
- `commitChanges(taskId, message, files)` — stage + commit с префиксом `[Auto-{taskId}]`
- `rollback(commitHash)` — `git revert`

### `@rag-system/code-graph`
AST-парсер на базе нативного TypeScript Compiler API:
- **ASTParser** — извлекает `classes`, `functions`, `interfaces`, `types` из TS/JS файлов
- **CodeGraph** — хранит символы в `Map`, строит граф зависимостей по именам
- Инкрементальный: при повторном вызове `addFile()` старые символы для файла заменяются

### `@rag-system/rag`
Гибридная система retrieval:
- **VectorStore** — HNSW индекс через `hnswlib-node` (cosine distance)
- **GraphRetriever** — комбинирует vector search + graph traversal (1 hop по зависимостям)

### `@rag-system/agents`
Агентная система:
- **BaseAgent** — абстрактный класс с `callLLM()` и `parseJSON()`
- **PlannerAgent** — декомпозиция задачи в JSON DAG
- **CoderAgent** — генерация файловых изменений в JSON
- **Orchestrator** — управляет полным пайплайном (plan → code → write → commit)

### `@rag-system/job-system`
Асинхронная обработка задач:
- **MemoryQueue** — in-memory очередь с приоритетами и статусами
- **JobWorker** — polling loop, забирает задачи и запускает Orchestrator

### `@rag-system/api`
HTTP API на Fastify:
- `POST /task` — создание задачи
- `GET /task/:id` — получение статуса
- Валидация через `zod`
- Автоматический запуск Worker при старте сервера

---

## Требования

| Компонент | Минимум | Рекомендуется |
|-----------|---------|---------------|
| Node.js | 18 LTS | 20 LTS |
| npm | 9+ | 10+ |
| Git | 2.30+ | 2.39+ |
| Ollama | 0.1.0+ | latest |
| RAM | 16 GB | 32 GB |
| Disk | 20 GB (модели) | 30 GB |

### Модели Ollama (необходимы)

```bash
ollama pull deepseek-coder-v2:16b    # ~10 GB
ollama pull qwen2.5-coder:7b          # ~4.5 GB
ollama pull nomic-embed-text           # ~270 MB
```

---

## Установка и запуск

### 1. Установка Node.js (если не установлен)

```bash
# Через nvm (рекомендуется)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.zshrc
nvm install 20
nvm use 20
```

### 2. Установка Ollama

```bash
# macOS
brew install ollama

# или прямая загрузка
curl -fsSL https://ollama.ai/install.sh | sh
```

### 3. Запуск Ollama и загрузка моделей

```bash
# В отдельном терминале — запустить сервер
ollama serve

# Скачать модели
ollama pull deepseek-coder-v2:16b
ollama pull qwen2.5-coder:7b
ollama pull nomic-embed-text
```

### 4. Клонирование и установка зависимостей

```bash
cd /Users/admin/Documents/work/rag-system

# Создать .env из шаблона
cp .env.example .env

# Установить все зависимости (workspace-aware)
npm install

# Собрать все пакеты
npm run build
```

### 5. Запуск системы

```bash
# Запуск API сервера (включает Worker автоматически)
node packages/api/dist/index.js
```

Сервер запускается на `http://localhost:3000`.

### 6. Отправка задачи

```bash
# Создать задачу
curl -X POST http://localhost:3000/task \
  -H "Content-Type: application/json" \
  -d '{"task": "Create a utility function for date formatting", "mode": "balanced"}'

# Проверить статус
curl http://localhost:3000/task/<task_id>
```

---

## Конфигурация

Все настройки — через переменные окружения в файле `.env`.  
Подробное описание каждой переменной — в `.env.example`.

Ключевые переменные:

| Переменная | Назначение | По умолчанию |
|-----------|-----------|-------------|
| `OLLAMA_BASE_URL` | Адрес Ollama API | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL_LARGE` | Модель для кодинга | `deepseek-coder-v2:16b` |
| `OLLAMA_MODEL_SMALL` | Модель для планирования | `qwen2.5-coder:7b` |
| `API_PORT` | Порт HTTP API | `3000` |
| `LOG_LEVEL` | Уровень логирования | `info` |
| `PROJECT_ROOT` | Путь к целевому репозиторию | `process.cwd()` |
| `SAFE_EXEC_DRY_RUN` | Режим без записи | `false` |
| `JOB_MAX_RETRIES` | Макс. повторов | `3` |

---

## API Reference

### `POST /task`

Создать новую задачу для автономного выполнения.

**Request:**
```json
{
  "task": "Add input validation to the user registration endpoint",
  "mode": "balanced"
}
```

| Поле | Тип | Описание |
|------|-----|---------|
| `task` | `string` | Описание задачи на естественном языке |
| `mode` | `"fast" \| "balanced" \| "deep"` | Режим: fast — маленькая модель для всех, deep — большая для всех |

**Response:**
```json
{
  "task_id": "1713312000000",
  "status": "queued"
}
```

### `GET /task/:id`

Получить статус задачи.

**Response:**
```json
{
  "task_id": "1713312000000",
  "status": "completed",
  "logs": []
}
```

Статусы: `queued` → `running` → `completed` / `failed`

---

## Интеграция с VSCode

### Вариант 1: REST Client Extension

Установите расширение **REST Client** (`humao.rest-client`) и создайте файл `requests.http`:

```http
### Create Task
POST http://localhost:3000/task
Content-Type: application/json

{
  "task": "Refactor the authentication module to use JWT tokens",
  "mode": "deep"
}

### Check Task Status
GET http://localhost:3000/task/1713312000000
```

### Вариант 2: Tasks в VSCode

Создайте `.vscode/tasks.json` в корне проекта:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "RAG: Start Server",
      "type": "shell",
      "command": "node packages/api/dist/index.js",
      "options": { "cwd": "${workspaceFolder}" },
      "isBackground": true,
      "problemMatcher": []
    },
    {
      "label": "RAG: Build All",
      "type": "shell",
      "command": "npm run build",
      "options": { "cwd": "${workspaceFolder}" },
      "group": { "kind": "build", "isDefault": true }
    },
    {
      "label": "RAG: Send Task",
      "type": "shell",
      "command": "curl -s -X POST http://localhost:3000/task -H 'Content-Type: application/json' -d '{\"task\": \"${input:taskDescription}\", \"mode\": \"${input:taskMode}\"}'",
      "problemMatcher": []
    }
  ],
  "inputs": [
    {
      "id": "taskDescription",
      "description": "Describe the engineering task",
      "type": "promptString"
    },
    {
      "id": "taskMode",
      "description": "Select mode",
      "type": "pickString",
      "options": ["fast", "balanced", "deep"],
      "default": "balanced"
    }
  ]
}
```

### Вариант 3: Кастомный VSCode Extension (будущее)

Система предоставляет HTTP API, совместимый с любым клиентом. Для full-featured интеграции можно разработать расширение, которое:
- Подписывается на SSE-стрим задачи (`GET /task/:id/stream`)
- Показывает прогресс в Sidebar
- Открывает diff-preview при завершении

---

## Известные ограничения и план доработок

### 🔴 Критические (требуют реализации для production)

1. **Отсутствуют 4 из 8 агентов**
   - `ArchitectAgent` — не реализован, Orchestrator пропускает этап архитектурного дизайна
   - `TesterAgent` — не реализован, нет генерации тестов
   - `ReviewerAgent` — не реализован, нет code review перед коммитом
   - `FixerAgent` — не реализован, нет self-healing loop

2. **Нет цикла самоисправления (self-healing)**
   - Orchestrator выполняет шаги линейно без retry при ошибках агентов
   - Необходим цикл: Code → Test → Review → Fix → retry (max 3)

3. **Config не подключён к ENV**
   - `ModelRouter` хардкодит модели вместо чтения из `process.env`
   - `OllamaClient` хардкодит `baseUrl`
   - `MemoryStore`, `VectorStore`, `GitEngine` — не читают переменные окружения

4. **VectorStore не сохраняет labelMap**
   - При перезапуске теряется маппинг `labelId → symbolId`
   - Нужна сериализация в JSON или SQLite

5. **Нет SSE/WebSocket для real-time обновлений**
   - `GET /task/:id` не возвращает логи и прогресс
   - Для VSCode интеграции необходим streaming

### 🟡 Важные (влияют на качество)

6. **AST-парсер: наивное извлечение зависимостей**
   - `extractDependenciesNaive()` собирает все идентификаторы, включая ключевые слова TS
   - Нужен TypeChecker для реальных ссылок

7. **Code Graph не персистентен**
   - Граф живёт только в памяти, при перезапуске пересканирование
   - Нужна сериализация в `data/graphs/`

8. **Нет Ollama health check**
   - Система не проверяет доступность Ollama перед запуском
   - Нет fallback при недоступности

9. **Router использует `/api/generate` вместо `/api/chat`**
   - Ollama `/api/chat` лучше поддерживает system/user/assistant роли
   - Текущий формат сообщений — наивная конкатенация

10. **Job System: нет pause/resume**
    - `MemoryQueue` поддерживает только `queued/running/completed/failed`
    - Нет механизма паузы и возобновления задач

11. **Task ID** генерируется через `Date.now()` — коллизии при concurrent requests

### 🟢 Улучшения (polish)

12. **Нет CORS middleware** на Fastify — нужен для обращений из браузера/VSCode webview
13. **Нет `GET /health`** эндпоинта для мониторинга
14. **Нет unit-тестов** — ни один пакет не имеет тестов
15. **`pino-pretty`** нужно добавить в `devDependencies` пакета `shared`
16. **Нет graceful shutdown** — worker не останавливается корректно при SIGTERM
17. **Backup filename** включает полный путь с `/` заменённым на `_` — очень длинные имена, лучше использовать hash
18. **Orchestrator не возвращает структурированный результат** — нет `plan`, `files_changed`, `test_results` в ответе API

---

## Лицензия

Private — Internal Use Only
