# ROADMAP — RAG System

> **Что это.** Текущее состояние системы + ближайшие 2–3 итерации. История — в [CHANGELOG.md](CHANGELOG.md).
> **Цель v1.0.** Локальная связка llama.cpp → VSCode → Cline / Roo Code без облачных подписок.
> **Главный тезис.** Размер локальной модели зафиксирован — качество вытаскивает архитектура: маленькая модель + умный contextual routing > большая модель + наивный prompt.

**Статус:** 🟢 v1.54 done (2026-05-16). Dirty working tree fix + TesterAgent async rules. Cross-repo vite: **2/6 ✅** (V2+V5 committed). Прогрессия: 0/6 → 1/6 → 2/6 за 3 версии. Blockers: 16–25K ctx (V1/V3, нужен 32K aux), large-file nav (V4/V6). 589 тестов.
**Coder model:** `gemma-4-26b-a4b-it-mxfp4-moe-ctx-32k` (`LLM_LARGE_MODEL=gemma`).
**TESTER_ENABLED:** true.
**RAG_MAX_CONTEXT_TOKENS:** 1500 рекомендованный default (раньше 3000) — context-budget фикс v1.38.
**Backend:** llama-swap (local endpoint, see `.env`), tool-calling Coder/Fixer дефолт.
**Тесты:** 589/589 unit-tests (+ 3 pre-existing ASTParser native failures), 12/12 пакетов чисто.
**Последнее обновление:** 2026-05-16.

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

#### v1.34 — Hybrid search (BM25 + dense с RRF) — ✅ 2026-05-08
- [x] Pure-TS BM25Index (k1=1.5, b=0.75), no external deps
- [x] RRF (k=60) merge dense + BM25 в GraphRetriever
- [x] `data/backups/**` excluded from indexCodebase
- [x] interceptToolCall hook в BUGFIX_SPEC (L4.1 Fixer regression fix)
- [x] Bench: L1.1 3/3, L4.1 2/3 (interceptToolCall ✓)
- [x] **Design:** [docs/designs/v1.34-hybrid-search.md](docs/designs/v1.34-hybrid-search.md)
- [x] **Bench:** [2026-05-08-v1.34-hybrid-search.md](docs/benchmarks/runs/2026-05-08-v1.34-hybrid-search.md)

#### v1.34.1 — Release prep (2026-05-08) — ✅
- [x] BUGFIX_SPEC micro-fix: WORKFLOW шаг 2 → 4-шаговый алгоритм для тест-фейлов; `as Type` anti-pattern в COMMON TS PATTERNS
- [x] README.md user-facing (EN): quickstart, архитектура, known limitations
- [x] LICENSE (MIT) + CONTRIBUTING.md
- [x] .vsix: 0 предупреждений, 29KB; repository + license поля в extension package.json
- [x] L4.1 bench confirm: **3/3** ✅ (r1: 285s, r2: 60s, r3: 110s — все byte-perfect: `} as User` → `createdAt: new Date().toISOString()`)

#### v1.35 — Pre-Reviewer TS check + Gemma 4 Coder — ✅ 2026-05-11

- [x] `TypeChecker.runOn(paths[])`: full-project tsc, фильтрует output к изменённым файлам
- [x] `applyAndCheckTs()` в `executeStep`: до Reviewer (2 Fixer retry на TS errors)
- [x] `step_noop` event + fail-fast при Coder 0 files (G2)
- [x] `stepFailures` map в `executePlanParallel` — информативный fail message (G3)
- [x] `FEATURE_SPEC.pruneHistory: true` — устранён context overflow (36k tokens)
- [x] `LLM_LARGE_MODEL=gemma` — Gemma 4 26B MoE (ctx-32k) как default Coder
- [x] qwen-coder-32k добавлен в llama-swap (q4_0 KV, flash-attn)
- [x] Bench: L2.x **7/8** ✅ (AC4); L3.x 1/3 (Reviewer блокер на архитектурных задачах)
- [x] **Design:** [docs/designs/v1.35-coder-reviewer-fix.md](docs/designs/v1.35-coder-reviewer-fix.md)
- [x] **Bench:** [2026-05-11-v1.35-gemma-l2x.md](docs/benchmarks/runs/2026-05-11-v1.35-gemma-l2x.md)

#### v1.36 — Lenient Reviewer + regression — ✅ 2026-05-11

- [x] Reviewer prompt: BLOCKING only — не отклонять за стиль/архитектуру
- [x] L1.x 3/3 ✅, L4.x 1/1 ✅ regression с Gemma

#### v1.37 — TESTER_ENABLED + L5.x bench — ✅ 2026-05-11

- [x] TesterAgent: правило "нельзя пустой describe", Fastify pattern fix
- [x] TestRunner: фильтр "No test found in suite"
- [x] L5.x comprehensive bench: 14/16 (87.5%)
- [x] Cumulative mode: 5/6 ✅, race condition documented
- [x] rag-system-target setup: main branch, tsconfig, npm build

#### v1.38 — Real-repo sprint + public release prep — ✅ 2026-05-13

- [x] **Sprint D1:** диагностика hono (326 файлов) + trpc (714 файлов) → 0/18 коммитов, каталог failure patterns
- [x] **Sprint D2:** 6 фиксов — `Promise.race([])` hang, baseline detection (filter pre-existing failures), context budget (`MAX_READ_LINES=350`, `HISTORY_KEEP_TAIL=4`, repo-map 5KB, prompt-context 10KB), RAG paths read-only для Coder, `applyAndCheckTs` skip test files, `runValidationLoop` использует `prodPaths`
- [x] **Результат после D2:** 6/16 (~38%) на реальных репо (JSDoc/count/parseQS/requestId на hono, onError/getErrCode на trpc)
- [x] VSCode extension finalize: `commit.commitHash` в событиях, второй StatusBar для phase, terminal notification, `Submit Task` команда с inline project picker
- [x] Cleanup: untracked `.DS_Store`/turbo-logs убраны, `.env.example` дополнен 7 переменными
- [x] Документация: переписаны `README.md`, `BENCHMARK.md`, `docs/SETUP.md`, `docs/ARCHITECTURE.md`
- [x] Push + GitHub release: `git tag v1.38`, visibility → public, topics
- [x] **Bench:** [2026-05-12-real-repo-diagnostic.md](docs/benchmarks/runs/2026-05-12-real-repo-diagnostic.md)
- [ ] **Не закрыто (перенесено в v1.39+):** cumulative pipeline merge-wait между задачами в worker; BUGFIX_SPEC паттерн для `_clear()` → `list().forEach(u => delete(u.id))`

#### v1.39-a — Cumulative merge-wait + noop detection (✅ 2026-05-14)

- [x] `CUMULATIVE_MODE=true` (env) + `CUMULATIVE_BRANCH=auto/cumulative` (env)
- [x] `GitEngine.resolveBaseBranch()` — task forks from cumulative branch when enabled; cumulative branch bootstrapped from defaultBranch on first use
- [x] `GitEngine.mergeIntoCumulative(taskBranch)` — `git merge --ff-only`; throws on conflict
- [x] `Orchestrator.runTask` — post-commit ff-merge call under cumulative flag; emits `cumulative_merged` / `cumulative_merge_failed` events; task itself stays `done` on merge failure (branch retained for manual review)
- [x] `NoopStepError` distinguishes "Coder produced 0 files" from generic step failures; `done.data.noopStepIds[]` exposed to consumers
- [x] `TaskEventType` extended with `cumulative_merged`, `cumulative_merge_failed`
- [x] Tests: 5 new in `git-engine` (cumulative branching + ff-merge happy/error), 4 new in `orchestrator` (cumulative on/off + noop counter). **543/543** ✅

#### v1.39-b — BUGFIX_SPEC patterns + validation_incomplete (✅ 2026-05-14)

- [x] `_clear()` / `_reset()` / `__resetForTests()` test-isolation antipattern → `for (const u of store.list()) store.delete(u.id)` workflow in BUGFIX_SPEC `COMMON TS PATTERNS`
- [x] `validation_incomplete` (T3): `runValidationLoop` now wraps Promise.all in `Promise.race` with `VALIDATION_TIMEOUT_MS` (default 300_000ms) + top-level try/catch — always emits a terminal `validation_fail` with `reason='timeout_or_crash'` after `validation_start`
- [x] `VALIDATION_TIMEOUT_MS` env added; documented at config site
- [x] Tests: +2 in orchestrator (runner-throws, hang-on-timeout); **545/545** ✅
- [ ] Bench L4.x ×3 + real-repo T3 re-run (will land with v1.39 final)

#### v1.39-c — Reviewer-reject Fixer dispatch (✅ 2026-05-14)

- [x] **Root cause:** step-level Reviewer-reject path was unconditionally calling patch-based `this.fixer.execute(...)` even with `TOOL_CALLING_CODER=true` (default since v1.32-d). Patch-Fixer only saw `currentChanges` as `{edits:[{search,replace}]}` — no full-file content. Source of L2.x `reviewer_reject` in v1.38 real-repo bench (T6, H4).
- [x] **Fix:** dispatch by `config.agents.toolCallingCoder` (matches pre-Reviewer TS check + validation loop):
  - `true` → `runTaskAgent(BUGFIX_SPEC, {issues: review.issues, currentFiles: currentChanges, ...})` — Fixer can `read_file` for full content + structural tools
  - `false` → legacy `this.fixer.execute(...)` preserved
- [x] Design: [docs/designs/v1.39-c-reviewer-feedback-loop.md](docs/designs/v1.39-c-reviewer-feedback-loop.md)
- [x] Tests: +2 in orchestrator (BUGFIX_SPEC dispatch on tool-calling, patch fallback on legacy); **547/547** ✅
- [ ] Bench L1/L4 sandbox (regression guard 3+3) + real-repo T6/H4 (close `reviewer_reject` cohort)

#### v1.40-a — TesterAgent post-generation TS validation (✅ 2026-05-14)

- [x] **Root cause:** TesterAgent-generated test files were never TypeScript-checked before entering the pipeline — `isTestPath` filter excluded them from the pre-Reviewer TS check (v1.35). Bugs like `body is not defined` (L1.1 r2) and bad assertions (L4.1 r1) reached the validation stage and blocked commits on correct production changes.
- [x] `Orchestrator.validateAndFilterTestFiles()`: apply test files to disk → `typeChecker.runOn(testPaths)` → parse error output by path → discard files whose path appears in errors, restore disk state for those. Files that pass remain on disk for the rest of the pipeline. Tester stays best-effort: partial success (some valid, some discarded) is allowed.
- [x] `TesterAgent` prompt rules 11–12: explicit rule against undeclared variables (`body is not defined`) and against fragile list-length assertions without controlled state.
- [x] +3 unit tests (valid files kept, bad files discarded, tester crash handled). **550/550** ✅
- [x] **v1.40-b content guard:** pre-disk regex check discards files with no `it()/test()` call (empty describe — Rule 9 runtime failure, TypeScript-valid). +1 unit test. **551/551** ✅. Bench: [2026-05-14-v1.40-tester-validation.md](docs/benchmarks/runs/2026-05-14-v1.40-tester-validation.md). L1.1 sandbox: 2/3 → **3/3**.

### Phase 5 — Production storage (📋 après Phase 4)



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

## Известные ограничения (актуально на v1.39-a)

| Ограничение | Severity | Mitigation / план |
|---|---|---|
| Real-repo success rate ~38% (vs sandbox 87.5%) | HIGH | Context budget уже зажат; следующий рычаг — multi-hop retrieval + scope discipline (v1.40+) |
| Cumulative state регрессирует на всех локальных 32B моделях | HIGH (фундаментальное) | v1.39+ explicit merge-wait worker; полное решение требует Sonnet-class модель |
| Большие классы (>700 строк) ломают structural-anchor lookup | HIGH | Лучшая disambiguation; anchors v2 (line+signature) |
| Complex generics (tRPC-style builders) превышают контекст | HIGH | 32K ctx модель уже используется (gemma); upper bound уперт в 24GB VRAM |
| Cross-service refactoring (callsites в 8 файлах) теряет часть | HIGH | 1-hop graph traversal → multi-hop в v1.41 |
| 24GB VRAM cap → потолок 32B Q4 | HIGH (hardware) | Реалистичная цель: 70-80% atomic / 30-40% multi-file локально |
| HNSW JSON cap ~10K элементов | MEDIUM | v1.40 Qdrant migration |
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
5. ROADMAP — tick'нуть checkbox в Phase 4/5; обновить шапку если фаза закрылась

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
