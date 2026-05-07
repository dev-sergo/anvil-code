# ROADMAP — RAG System

> **Что это.** Текущее состояние системы + ближайшие 2–3 итерации. История — в [CHANGELOG.md](CHANGELOG.md).
> **Цель v1.0.** Локальная связка llama.cpp → VSCode → Cline / Roo Code без облачных подписок.
> **Главный тезис.** Размер локальной модели зафиксирован — качество вытаскивает архитектура: маленькая модель + умный contextual routing > большая модель + наивный prompt.

**Статус:** 🟡 v1.33 Phase A+B done (2026-05-07: BGE-reranker two-pass). Bench: L1.2/L1.3 baseline ✅, L4.1 регрессия 1/3, precision@5 = 0% (vocabulary gap → нужен BM25 v1.34).
**Backend:** llama-swap (operator's proxy на `172.20.10.4:8080`), tool-calling Coder/Fixer дефолт.
**Тесты:** 507/507 unit-tests, 12/12 пакетов собираются чисто.
**Последнее обновление:** 2026-05-07.

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
| `vscode-extension` | 🟢 100% | esbuild → ~18KB; activity bar + Projects/Tasks TreeView; OutputChannel формат SSE; команды Run Task / Index / Register |

---

## Текущая фаза: Phase 3 closure (✅ closed 2026-05-02)

Достигнуто:
- ✅ Patch-based editing (v1.23) — main защищён, файл никогда не разрушается
- ✅ Tool-calling Coder + Fixer (v1.30 → v1.30.5) — line-coord слой
- ✅ Structural anchor edits (v1.31) — AST-aware tools (add_method, add_route, add_import...) — убирают целые классы placement bugs by construction
- ✅ Fixer reliability (v1.32-a → a.5) — test-scope discipline, read-grants-write, retry symmetry, pathology guard
- ✅ llama-swap backend swap (v1.32-d) — `LLM_BACKEND=llamacpp` дефолт, ~50% быстрее Ollama baseline
- ✅ Task-agents (v1.32-c) — FEATURE/BUGFIX/REFACTOR specs над unified loop

**Бенчмарк baseline (v1.32-c retro, qwen-coder-long 16K, [run](docs/benchmarks/runs/2026-05-04-v1.32-c-task-agents.md)):**
- L1.1 atomic (FEATURE_SPEC) ×3 — 2/3 commits (1 fail = done-after-structural-error)
- L3.1 refactor (REFACTOR_SPEC) ×3 — 3/3 byte-perfect, mean 51s
- L4.1 bug-fix (BUGFIX_SPEC) ×5 — 3/5 commits (3/3 byte-perfect), healthy median 105s vs v1.32-d 5:49 (~3× faster)
- Cumulative state — регрессирует на всех локальных моделях (фундаментальное ограничение, не лечится prompt'ами)

---

## Next 2–3 iterations (по приоритету)

### v1.32-c.1 — done-after-error nudge (✅ 2026-05-05) — Phase 3 fully closed

- [x] NO_PROGRESS_NUDGE в `runTaskAgent`: intercept `done()` при 0 successful edits, cap=1 nudge/loop
- [x] +6 unit-tests, 499/499
- [x] Re-bench: L1.1 3/3 ✅ (было 2/3), L4.1 3/3 ✅ (было 3/5), L3.1 byte-perfect ✅
- [x] **Design:** [docs/designs/v1.32-c.1-no-progress-nudge.md](docs/designs/v1.32-c.1-no-progress-nudge.md)
- [x] **Bench:** [2026-05-05-v1.32-c.1-no-progress-nudge.md](docs/benchmarks/runs/2026-05-05-v1.32-c.1-no-progress-nudge.md)

### Phase 4 — Storage & retrieval upgrade (📋 после v1.32-c.1, главная атака на «сотни файлов»)

Все три — независимые, можно делать параллельно. ROI измеряется на rag-system-target (91 файл) + крупных open-source TS репо.

#### v1.33 — Re-ranker (BGE-reranker-v2-m3) — ✅ 2026-05-07
- [x] Локальный BGE-reranker (~418MB, llama-swap alias `reranker`)
- [x] Top-30 → BGE сортирует → top-5 в GraphRetriever; graceful fallback; kill-switch RAG_RERANKER_ENABLED
- [x] Bench: L1.2/L1.3 baseline впервые (2/3, 3/3 ✅); L2.1/L2.2 precision@5 = 0/3 baseline = 0/3 reranker (vocabulary gap → BM25 needed)
- [x] **Design:** [docs/designs/v1.33-reranker.md](docs/designs/v1.33-reranker.md)
- [x] **Bench:** [2026-05-07-v1.33-reranker.md](docs/benchmarks/runs/2026-05-07-v1.33-reranker.md)

#### v1.34 — Hybrid search (BM25 + dense с RRF) (~1-2 дня)
- [ ] Pure-TS BM25 (или sqlite-fts5) над symbol bodies + `pMap` для индексации
- [ ] RRF (k=60 default) merge top-N dense + top-N BM25
- [ ] Атакует vocabulary gap — поиск по точному имени символа сейчас может промахнуться
- [ ] Bench: queries по rare identifiers (вспомогательные функции, утилиты)
- [ ] **Design needed:** [docs/designs/v1.34-hybrid-search.md](docs/designs/v1.34-hybrid-search.md)

#### v1.35 — Multi-hop transitive closure в code-graph (~3-5 дней)
- [ ] При индексации compute closure(symbol, max_depth=3) — кладём в `dependencies_closure` поле
- [ ] GraphRetriever отдаёт closure (не только 1-hop) с token budget
- [ ] Атакует cumulative state regression (модель не видит дальние зависимости)
- [ ] Bench: L2.3 cumulative ×5 — target 4/5 GREEN (vs текущий variance 1/3)
- [ ] **Design needed:** [docs/designs/v1.35-multi-hop-closure.md](docs/designs/v1.35-multi-hop-closure.md)

### Phase 5 — Production storage (📋 после Phase 4)

#### v1.40 — Qdrant migration
- [ ] Заменить HNSW JSON на Qdrant (vector DB), payload-фильтрация (например, «только из packages/api/»)
- [ ] Сохранить тот же `VectorStore` interface; реализация switchable через env

#### v1.41 — SQLite symbol table (вместо CodeGraph JSON Map)
- [ ] `symbols` (id, file_path, kind, name, signature, body, embedding_id) + `dependencies` (from_id, to_id, kind)
- [ ] Multi-hop queries через recursive CTE
- [ ] Migration script с CodeGraph JSON

### Опциональные micro-iterations (можно вставить в любой момент)

- v1.32-d.2 — modify-non-existent → create fallback (Coder write to file который не существует)
- v1.32-d.3 — Fixer prompt nudge на navigation от тестов к production (дополнение v1.32-a.1 read-grants-write)
- v1.36 — Semantic task cache (embed task descriptions, reuse solution scaffolds)

---

## Известные ограничения

| Ограничение | Severity | Mitigation |
|---|---|---|
| Cumulative state регрессирует на всех локальных 32B моделях | HIGH (фундаментальное) | Phase 4 v1.35 multi-hop closure — partial mitigation |
| 24GB VRAM cap → потолок 32B Q4, не достичь Sonnet/GPT-4 reasoning | HIGH (hardware) | Реалистичная цель: 70-80% задач локально |
| Coder/Fixer prompt-accretion (model adaptation) | MEDIUM | Регулярные prompt-консолидации (v1.32-a.3 pattern) |
| HNSW JSON cap ~10K элементов | MEDIUM | Phase 5 v1.40 Qdrant |
| 1-hop dependencies, нет transitive closure | MEDIUM | Phase 4 v1.35 |
| TesterAgent на vitest эмитит jest-style mocks | LOW | `TESTER_ENABLED=false` workaround |
| Нет hybrid search (BM25 fallback) | LOW-MED | Phase 4 v1.34 |
| Нет re-ranker | LOW-MED | Phase 4 v1.33 |
| Нет task cancellation `POST /task/:id/cancel` | LOW | UX nice-to-have |
| Нет observability (Langfuse/OTel) | LOW | pino + бенчмарки покрывают для single-user local |

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
5. ROADMAP — tick'нуть checkbox в Phase 4/5; обновить шапку если фаза закрылась

---

## Ссылки

- **История:** [CHANGELOG.md](CHANGELOG.md) (полный архив v1.0 → v1.32-d)
- **Design docs:** [docs/designs/](docs/designs/)
- **Bench runs:** [docs/benchmarks/runs/](docs/benchmarks/runs/) (26 файлов, 2026-04-27 → 2026-05-05)
- **Bench methodology:** [docs/benchmarks/README.md](docs/benchmarks/README.md), [tasks.md](docs/benchmarks/tasks.md)
- **llama-swap reference:** [docs/llama-api-reference.md](docs/llama-api-reference.md)
- **LLM tools survey:** [docs/llm-tools-and-practices.md](docs/llm-tools-and-practices.md)
- **Sandbox:** `/Users/admin/Documents/work/rag-system-sandbox` (clean state per L1/L2 bench)
- **Scale target:** `/Users/admin/Documents/work/rag-system-target` (91 файл TS, 6717 LOC)
