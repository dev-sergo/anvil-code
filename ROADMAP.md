# ROADMAP — Anvil-Code

> **Что это.** Текущее состояние системы + ближайшие 2–3 итерации. История — в [CHANGELOG.md](CHANGELOG.md).
> **Цель v1.0.** Локальная связка llama.cpp → VSCode → автономный coding-агент без облачных подписок.
> **Главный тезис.** Размер локальной модели зафиксирован — качество вытаскивает архитектура: маленькая модель + умный contextual routing > большая модель + наивный prompt.

## Снимок состояния (2026-06-12)

**Текущий релиз:** ✅ v1.71 (2026-06-12) — bench 12/12 (100%), все три action item подтверждены.

**Headline метрики:**
- **trpc bench:** 6/6 (100 %) v1.71 — контекстный guard устранил T3 overflow; Fixer budget fix помог T2/T6.
- **hono bench:** 6/6 (100 %) v1.71 — H6 commit bug устранён детерминированно.
- **Best real-repo:** 12/12 (100 %) — v1.71 и v1.68c
- **vite cross-repo:** 6/6 (100 %) — v1.63 с Qwen3-35B MoE, включая 1835-строчный файл.
- **Sandbox:** 14/16 (87.5 %), cumulative mode 6/6 (Gemma) + 5/5 (Qwen3 MoE).

**Конфигурация по умолчанию:**
- Active model: **Qwen3-35B MoE** (`LLM_LARGE_MODEL=qwen3-6-35b-a3b-ud-q4-k-m-ctx-32k-q4-0-kv`, ~11 tok/s, thinking mode, 32K ctx).
- Backend: llama-swap (local endpoint, see `.env`), tool-calling Coder/Fixer — дефолт.
- TESTER_ENABLED: true. RAG_MAX_CONTEXT_TOKENS: 1500. MAX_PROMPT_CONTEXT_BYTES: 49152.

**Hardware (RTX 3090, 2026-05-18):** Q6K_L 32B sweet spot — `ngl=56, q4_0 KV, 16K ctx` → **6.28 tok/s** (+15.6 % vs baseline 5.37). Qwen3 MoE на реальном контексте: ~11 tok/s.

**Тесты:** 644/647 unit-tests (3 pre-existing native ASTParser failures), 12/12 пакетов чисто.

**Последнее обновление:** 2026-06-12.

---

## Состояние пакетов

| Пакет | Готовность | Реализация |
|---|---|---|
| `shared` | 🟢 100% | types, config, logger, project-conventions, prompt-context, task-events |
| `model-router` | 🟢 100% | LlamaSwapClient (default) + OllamaClient (fallback); ModelBackend factory; per-role MODEL_ALIAS routing; chatWithTools с inline-content fallback |
| `memory` | 🟢 100% | MemoryStore (SQLite): tasks, adr, failures, file_hashes, embedding_cache, projects |
| `safe-exec` | 🟢 100% | SafeWriter, BackupManager (+ prune), DiffEngine, edit-applier (strict + tolerant), prettier-runner |
| `git-engine` | 🟢 100% | simple-git обёртка |
| `code-graph` | 🟢 100% | ASTParser (TS Compiler API + tree-sitter для py/rs/go), CodeGraph (in-memory Map + JSON), buildRepoMap (16K budget, prod/tests split) |
| `rag` | 🟢 100% | VectorStore (HNSW + JSON persistence), GraphRetriever (semantic top-k + 1-hop deps), pMap parallel embed, embedWithCache с task-prefixes |
| `agents` | 🟢 100% | BaseAgent, Planner, Architect, Coder, Tester, Reviewer, Fixer, Orchestrator (DAG); ToolCallingCoder + ToolCallingFixer (5 + 6 structural tools, pathology guard, scope policy); task-agents (FEATURE/BUGFIX/REFACTOR specs) |
| `job-system` | 🟢 100% | MemoryQueue, JobWorker (multi-project, graceful shutdown) |
| `api` | 🟢 100% | Fastify + CORS + rate-limit; /health, /task, /task/:id, /task/:id/stream (SSE), /tasks, /index, /projects, /project/:id, POST /project |
| `mcp-server` | 🟢 100% | stdio transport; 7 tools + 4 resources + 4 prompts; multi-project через project_id |
| `vscode-extension` | 🟢 100% | esbuild → ~18KB; activity bar + Projects/Tasks TreeView; SSE OutputChannel + 2 StatusBar items (project + phase); terminal toast с commit hash; команды Submit Task / Index / Register / Show Output |

---

## История фаз (закрыты ✅)

> Подробный лог каждой версии — в [CHANGELOG.md](CHANGELOG.md). Здесь — только итог фазы и эффект на метрику.

### Phase 1–2 — Foundation (v1.0 → v1.22, до 2026-04)
Pipeline + RAG retrieval + Git engine + 12 пакетов. Patch-based editing (v1.23) защищает main, файл никогда не разрушается.

### Phase 3 — Tool-calling agents (v1.30 → v1.32-d, ✅ 2026-05-02)
- Tool-calling Coder + Fixer (read_file / replace_in_file / create_file / delete_file / done)
- Structural anchor edits (add_method, add_route, add_import…) убирают placement bugs by construction
- Task-agents (FEATURE / BUGFIX / REFACTOR specs)
- llama-swap backend swap → ~50 % быстрее Ollama
- **Эффект:** L1/L4 baseline стабилизировался: 3/3 atomic, 3/3 refactor byte-perfect

### Phase 4 — Storage & retrieval upgrade (v1.33 → v1.65d, ✅ 2026-05-20)

| Версия | Дата | Дельта | Метрика |
|---|---|---|---|
| v1.33 | 05-07 | BGE-reranker, top-30→top-5 | L1 baseline |
| v1.34 | 05-08 | Pure-TS BM25 + RRF dense merge | hybrid search |
| v1.35 | 05-11 | Pre-Reviewer TS check + Gemma 4 26B Coder | L2 7/8 ✅ |
| v1.36 | 05-11 | Lenient Reviewer (BLOCKING-only) | L1/L4 3/3 ✅ |
| v1.37 | 05-11 | TESTER_ENABLED + L5.x bench | sandbox **14/16 (87.5 %)** |
| v1.38 | 05-13 | Real-repo sprint (hono+trpc), context budget, public release | real-repo 6/16 (~38 %) |
| v1.39-a | 05-14 | Cumulative merge-wait + noop detection | cumulative chain stable |
| v1.39-b | 05-14 | Validation timeout guard | устранён `validation_incomplete` |
| v1.39-c | 05-14 | Reviewer-reject Fixer dispatch | устранён cohort `reviewer_reject` на T6/H4 |
| v1.40 | 05-14 | TesterAgent post-gen TS validation + content guard | устранён `body is not defined` |
| v1.41 | 05-14 | Planner retry + noop retry, monorepo meta | устранён `ts_fail`, `llm_parse_fail` |
| v1.42–v1.47 | 05-15 | Full 12-task bench refinement | hono **6/6**, trpc 5/6 |
| v1.50 | 05-15 | Structural anchor v2 (overload-aware) | L6 hono large-file **3/4** |
| v1.51 | 05-15 | Extension detection (zod, vite, …) | zod cross-repo **4/4** |
| v1.52 | 05-15 | `GET /project/:id/healthcheck` | pre-flight для новых repo |
| v1.56–v1.59 | 05-16 → 17 | Qwen-coder-32k промежуточная | vite intermediate runs |
| v1.60 | 05-17 | Reviewer leniency tuning + Coder ESM hint | модельный tradeoff документирован |
| v1.61 | 05-18 | **Qwen3-35B MoE 32K** как default Coder | sandbox 7/7, 11 tok/s |
| v1.62 | 05-18 | ESM production guard | retry Coder на `require()` в ESM |
| v1.63 | 05-18 | `read_file start_line` + large-file nudge | **vite 6/6 ✅**, sandbox 6-7/7 |
| v1.64 | 05-19 | Repo memory (`repo_patterns` table) | повторяющиеся ошибки видны Planner/Coder |
| v1.65a | 05-19 | Reviewer leniency для refactor шагов | устранён false-reject на L3.1 |
| v1.65b | 05-19 | **`add_type_member`** AST-инструмент | T6 noop → commit, 900-line dataLoader.ts |
| v1.65c | 05-19 | TestRunner timeout 60s→120s | устранён false `commit_skipped` на trpc |
| v1.65d | 05-20 | `add_type_member` intersection types + FEATURE_SPEC ADD OPTION rule | trpc **5/6 (83 %)**, Qwen3 = Gemma v1.43 peak |

**Headline эффект Phase 4:** real-repo **42 % → 92 %**, hono **0/6 → 6/6**, cross-repo (zod, vite) **0 → 100 %**.

---

## Текущая фаза: Phase 5 — Multi-hop retrieval & production storage

**Цель.** Снять ограничение «1-hop graph + HNSW JSON cap ~10K» — главный блокер для cross-service refactoring (callsites в 5+ файлах) и для проектов >10K символов.

### v1.66 — Qdrant scope filter (✅ done — 2026-05-27)

- [x] `packageName` payload field в Qdrant; `extractPackageName()` экспортирован
- [x] `VectorStore` interface расширен `packageName?` фильтром; HNSW — no-op
- [x] `QdrantVectorStore.search()` — приоритет `packageName` exact-match > `filePath` fallback
- [x] Migration script `patch-qdrant-payload.ts` — 2006 points patched (idempotent)
- [x] Unit tests: `extract-package-name.test.ts` (12 cases), `qdrant-vector-store.test.ts` (+2)
- [x] Bench 2026-05-27: trpc 4/6 (67%), hono 5/6 (83%), total 9/12 (75%) — Δ −1 vs v1.65d (model variance)

### ✅ v1.67 — SQLite symbol table + multi-hop queries

- [x] Таблицы `symbols` + `dependencies` в `packages/memory` (MemoryStore.symbolTable)
- [x] Recursive CTE для multi-hop closure (callers-of-callers ≤ depth 3, DISTINCT + LIMIT 200)
- [x] Migration: `migrate-graph-to-sqlite.ts` (idempotent, walks data/projects/*)
- [x] BFS fallback при пустом SQLite (depth capped at 1 для безопасности)
- [x] `RAG_GRAPH_HOPS` default 1 → 3; `Qdrant scope filter applied` → LOG_LEVEL=info
- [x] Bench 2026-05-27: trpc 4/6 (67%), hono 5/6 (83%), total 9/12 (75%) — Δ 0 vs v1.66

### ✅ v1.68 — Bench repair: correct T2/T5/H4 tasks

- [x] T2-new: `requestTimeout` in `nodeHTTPRequestHandler` — ✅ `efb8d69`
- [x] T5-new: `getConnectionCount()` on `createHTTPServer` — ✅ `3151a07` (bug fix by hand)
- [x] H4-new: `responseTime` middleware in hono — ✅ `65e1471`
- [x] Process fix: grep repo before writing bench tasks
- [x] Bench 2026-05-27: corrected tasks 3/3 → effective total **12/12 (100%)**

### ✅ v1.68b — Full re-bench с corrected task set

- [x] 12 задач verified-absent; T2 requestTimeout → H6 buildUrl
- [x] Bench 2026-05-27: trpc 5/6 (83%), hono 6/6 (100%), **total 11/12 (92%)** — честная baseline
- [x] T2 (`requestTimeout`) ❌ стабильно — разобрали и починили в v1.68c

### ✅ v1.68c — T2 fix + infrastructure bugs (2026-05-29)

- [x] LLM_URL не загружался при перезапуске сервера (fix: `node --env-file=.env`)
- [x] Fixer мог удалять Coder-produced test файлы (`delete_file` теперь заблокирован через `interceptToolCall`)
- [x] Fixer prompt: уточнён раздел SCOPE для test-setup bugs
- [x] T2 `requestTimeout` ✅ `ae645ab` — fake-timer mock test
- [x] Bench 2026-05-29: **total 12/12 (100%)** 🎉

### ✅ v1.69 — Repo memory v2: cross-project patterns (2026-05-29)

- [x] Content dedup: `issue_hash = sha256(normalize(issue))[0:16]`; ON CONFLICT → `hit_count += 1`
- [x] Frequency ranking: `getRepoPatterns()` сортирует по `hit_count DESC`
- [x] Cross-project: `MemoryStore.getCrossProjectPatterns()` объединяет паттерны из всех registered project DBs
- [x] Prompt rendering: `[×N]` prefix + `(cross-project)` label
- [x] Idempotent migration: ALTER TABLE + UNIQUE INDEX

Design: [docs/designs/v1.69-repo-memory-v2.md](docs/designs/v1.69-repo-memory-v2.md)

### v1.70 — Bench re-run ✅ (2026-05-29)

Bench: 8/12 (67%). T2❌ T3❌ T6❌ T (model variance), H6❌ (commit bug). Cross-project patterns: inconclusive.

Run: [2026-05-29-v1.70-cross-project-bench.md](docs/benchmarks/runs/2026-05-29-v1.70-cross-project-bench.md)

### ✅ v1.71 — Commit completeness + context guard + Fixer budget (code-complete 2026-06-09)

- [x] **H6-type bug:** `GitEngine.listWorkingChanges()` (`git status` → все изменённые/untracked пути); оркестратор перед commit объединяет его с заявленным списком файлов вместо того чтобы полагаться только на список Coder'а. Ветка форкается из чистой базы → всё изменённое = вывод задачи.
- [x] **T3 context overflow guard:** `buildPromptContext` enforce'ит общий байтовый бюджет (`MAX_PROMPT_CONTEXT_BYTES`, 48KB). Прун по приоритету: RAG-сниппеты → repo-map; essential-секции не выбрасываются. Логируется, не silent.
- [x] **T2/T6 Fixer reliability:** `BUGFIX_SPEC.maxToolCalls` 30 → 50 (как FEATURE_SPEC). Validation loop уже даёт fresh-context ретраи — связывал per-invocation бюджет.
- [ ] **Bench re-run:** ⏳ pending — нужен локальный llama.cpp endpoint + hono/trpc. Ожидание: H6 ✅ детерминированно, T3 без overflow, T2/T6 частично (model variance ~25% остаётся).

CHANGELOG: [v1.71](CHANGELOG.md)

### Опциональные micro-iterations (можно вставить в любой момент)

- Task cancellation endpoint `POST /task/:id/cancel`
- Observability — Langfuse / OTel экспорт (single-user локально пока не нужен)
- SSE raw-LLM-token стрим (поверх существующего event stream)
- Semantic task cache — embed описаний задач, переиспользование scaffolds для похожих

---

## Известные ограничения (актуально на v1.65d)

| Ограничение | Severity | Mitigation / план |
|---|---|---|
| Complex generics (tRPC-style builders) — variance на thinking-mode моделях | HIGH | `add_type_member` (v1.65b) частично решает; полностью требует Sonnet-class или explicit no-thinking режим |
| Cross-service refactoring (callsites в 5+ файлах) теряет часть | MEDIUM | 1-hop graph traversal → multi-hop closure в v1.67 (recursive CTE поверх SQLite symbol table) |
| Большие классы (>700 строк) с complex generics | MEDIUM | L6 hono 3/4 (75 %); 780-line context.ts с overload generics всё ещё fail |
| HNSW JSON cap ~10K элементов | MEDIUM | Qdrant migration в v1.66 |
| 24GB VRAM cap → потолок 32B Q4 | HIGH (hardware) | Реалистичная цель: 70–80 % atomic / 30–40 % multi-file локально |
| TypeScript / JS only для structural tools | MEDIUM | py/rs/go парсятся для контекста, structural edits — только TS |
| Cumulative state на 32B локально | LOW (закрыто архитектурно) | v1.39-a explicit merge-wait + cumulative branch; Gemma 6/6, Qwen3 MoE 5/5 |
| TesterAgent на vitest эмитит jest-style mocks | LOW-MED | `TESTER_ENABLED=false` workaround |
| Нет task cancellation `POST /task/:id/cancel` | LOW | UX nice-to-have |
| Нет observability (Langfuse/OTel) | LOW | pino + бенчмарки покрывают для single-user local |
| SSE стримит только структурированные events, не raw LLM tokens | LOW | Roadmap item; не блокирует UX |

---

## Документация и workflow

| Артефакт | Что туда | Когда |
|---|---|---|
| **[CHANGELOG.md](CHANGELOG.md)** | Append-only chronological log; 1 запись на версию (5-15 строк) | После каждой итерации |
| **[docs/designs/](docs/designs/)** | Pre-impl design (TL;DR / Goals / Architecture / Phases / AC); шаблон [_template.md](docs/designs/_template.md) | Перед любой итерацией ETA > 1 день или архитектурным сдвигом |
| **[docs/benchmarks/runs/](docs/benchmarks/runs/)** | Post-impl measurements; шаблон [_template.md](docs/benchmarks/runs/_template.md) | После каждой итерации с поведенческим изменением |
| **ROADMAP.md** (этот файл) | Текущее состояние + next 2-3 итерации; ужать обратно если разрастается | Tick checkbox + дата при каждой итерации |

**Lifecycle итерации:**
1. Design doc (если нетривиально) → `docs/designs/v1.X-tag.md` ДО первого коммита кода
2. Implementation
3. Benchmark run-file → `docs/benchmarks/runs/YYYY-MM-DD-v1.X-tag.md` (по `_template.md`)
4. CHANGELOG entry — 1 запись СВЕРХУ файла, ссылки на design + bench
5. ROADMAP — tick'нуть checkbox в Phase 5; обновить snapshot-блок если фаза закрылась

---

## Ссылки

- **История:** [CHANGELOG.md](CHANGELOG.md)
- **Design docs:** [docs/designs/](docs/designs/)
- **Bench runs:** [docs/benchmarks/runs/](docs/benchmarks/runs/)
- **Bench methodology:** [docs/benchmarks/README.md](docs/benchmarks/README.md), [tasks.md](docs/benchmarks/tasks.md)
- **llama-swap setup:** [docs/SETUP.md](docs/SETUP.md)
- **Architecture:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Sandbox:** `rag-system-sandbox/` (clean state per L1/L2 bench)
- **Scale target:** `rag-system-target/` (91 файл TS, dogfood target)
