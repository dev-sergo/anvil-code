# Changelog — RAG System

> Хронологический архив итераций. Каждая запись — что изменилось, зачем, результат, ссылки на design / bench.
> Формат жёстко append-only. Новые итерации добавляются СВЕРХУ (newest first).
> Подробности pre-impl — [docs/designs/](docs/designs/), измерения — [docs/benchmarks/runs/](docs/benchmarks/runs/).

---

## v1.38 — Real-repo sprint + public release prep (2026-05-13)

**Real-repo diagnostic + fixes (sprint D1–D2, коммит `67562de`):** Запуск 18 задач на `honojs/hono` (326 файлов) и `trpc/trpc` (714 файлов) дал **0/18 коммитов** в День 1. Шесть фиксов в День 2: (1) `Promise.race([])` hang в `executePlanParallel` когда все шаги синхронно скипнуты; (2) **baseline detection** — tsc+test failures на чистом репо считаются один раз и фильтруются из validation (snapshot-фейлы hono перестают блокировать); (3) `MAX_READ_LINES=350`, `HISTORY_KEEP_TAIL=4`, repo-map budget 5 KB, prompt-context 10 KB — режут context overflow с 33% до ~10%; (4) RAG-retrieved paths теперь read-only для Coder — больше нет destructive side-effect edits (cache/index.ts → 42 строки); (5) `applyAndCheckTs` исключает test files из pre-Reviewer TS check; (6) `runValidationLoop` использует `runOn(prodPaths)` вместо полного tsc. **Результат: 6/16 (38%) на реальных репо** — JSDoc/count/parseQS/requestId (hono), onError/getErrCode (trpc). Bench: [2026-05-12-real-repo-diagnostic.md](docs/benchmarks/runs/2026-05-12-real-repo-diagnostic.md).

**VSCode extension finalize:** Кэш `commit` события теперь включает `commitHash` (`orchestrator.ts` ловит возврат `git.commitChanges`). Extension добавил: (a) команда `RAG System: Submit Task` (раньше `Run Task`) с inline-выбором проекта когда active не выбран; (b) второй StatusBar item трекает phase задачи (queued / running / planning / step / validate / committed) и гасится после стрима; (c) `notifyTerminal` — toast по `done`/`error` с `committed N files @ <hash>`, `commit skipped`, или `partial`; (d) `formatEventLine` отображает `commit`/`commit_skipped`/`commit_partial` с числами файлов и хешом; (e) `rag.showOutput` команда для клика по статус-бару. Контракт: `commit.data` теперь `{ fileCount, commitHash }` (обратная совместимость).

**Cleanup + .env.example sync:** Удалены untracked `.DS_Store` и `turbo-build.log` (уже в .gitignore). `.env.example` дополнен 7 недостающими переменными (`PROJECT_REGISTRY_PATH`, `PROJECTS_AUTO_REGISTER_DEFAULT`, `VECTORS_PATH`, `GRAPHS_PATH`, `BACKUPS_PATH`, `BACKUP_MAX_AGE_DAYS`, `BACKUP_PRUNE_INTERVAL_HOURS`); `LLM_LARGE_MODEL=gemma` зафиксирован как validated default (v1.35 7/8 L2.x); `RAG_MAX_CONTEXT_TOKENS=1500` задокументирован с объяснением trade-off под 8K/16K ctx модели. 12/12 пакетов компилируются, 530+/530+ тестов.

**Документация (публичная упаковка):** Переписан `README.md` — честные ожидания (что работает / что нет), реальные числа sandbox 87.5% / hono 38% / trpc 38%, 5-шаговый quickstart с llama-swap. Создан `BENCHMARK.md` — методология, scoring axes, по-категорийные таблицы, sprint D1→D2 транзишн, failure patterns. Создан `docs/SETUP.md` — установка llama-swap + GGUFs, рекомендуемый model stack, troubleshooting матрица. Создан `docs/ARCHITECTURE.md` — поток task→commit (ASCII диаграмма), agent responsibilities, API surface, packages map, как добавить нового агента.

**Скоуп v1.38 закрыт.** Готовность к public-релизу: `git tag v1.38`, GitHub visibility → public, добавить topics (`typescript`, `llm`, `rag`, `local-ai`, `code-assistant`, `multi-agent`).

---

## v1.37 — TESTER_ENABLED=true fix + comprehensive bench (2026-05-11)

**TesterAgent fixes (3 патча):** (1) Правило 9 — каждый testFiles entry должен содержать хотя бы один `it()`; пустой `describe` вызывает "No test found" в vitest → теперь явно запрещён. (2) Fastify test pattern — `FastifyInstance` вместо `ReturnType<typeof Fastify>` (TS1361 в некоторых конфигурациях). (3) TestRunner: фильтр "No test found in suite" — артефакт TesterAgent, не реальный тест-фейл; не блокирует коммит.

**Результат:** TESTER_ENABLED=true теперь работает — DELETE endpoint получил 239 строк корректных vitest-тестов (28/28 pass, `app.inject()`, интеграционные). Trade-off: невалидные тесты (e.g. `_clear()`) блокируют даже правильный код — следующий фикс в BUGFIX_SPEC.

**L5.x comprehensive benchmark:** 14/16 (87.5%) — sandbox 9/10, target 5/6. Ceiling: 1-4 файла ~90%, 5+ архитектурный ~30-50%. D1 SSE ✅, D2 CQRS ❌ (Reviewer правильно блокирует). Design: [v1.37-l5x-comprehensive-bench.md](docs/designs/v1.37-l5x-comprehensive-bench.md). Bench: [2026-05-11-v1.37-l5x-comprehensive.md](docs/benchmarks/runs/2026-05-11-v1.37-l5x-comprehensive.md).

**Cumulative mode test:** 5/6 ✅ — pipeline накапливает изменения, merge conflicts разрешаются, Reviewer блокирует плохой код на сложном накопленном стейте. Race condition при быстрой подаче задач требует явного merge-wait.

---

## v1.36 — Lenient Reviewer + regression tests (2026-05-11)

**Reviewer prompt rewrite:** Reviewer (qwen3) переориентирован с "correctness, security, quality" на строгое разделение: BLOCKING (неверная реализация, runtime bug, сломан существующий код) vs NON-BLOCKING (стиль, архитектура, type annotations, edge cases). Результат: L3.4 Zod validation (4 файла) перешла из "Reviewer 3× reject" в коммит. L3.3 (repository pattern) теперь падает корректно на validation/tests, а не на Reviewer.

**Regression test Gemma 4 26B (L1.x + L4.x):**
- L1.1 `/health` ✅, L1.2 Zod validation ✅, L1.3 `/stats` + accountAge ✅ (correct `.getTime()`)
- L4.1 bug fix ✅ (createdAt restored byte-perfect, bonus: 201 status в route)
- **4/4 без регрессий** — Gemma работает на всех уровнях сложности

**Bench Этап 2 (L3.x с новым Reviewer):**
- L3.3 (repository pattern, 5 файлов): Reviewer одобряет → validation/tests ловят несовместимость DI → commit_skipped (правильное поведение)
- L3.4 (Zod schemas, 4 файла): **✅ коммит** — 3 файла + новый schemas/users.ts

---

## v1.35 — Pre-Reviewer TS check + Gemma 4 Coder (2026-05-11) — L2.x unblocked 0/8→7/8

**Pipeline:** `TypeChecker.runOn(paths[])` добавлен в `safe-exec` — запускает полный `tsc --noEmit` на проекте и фильтрует output к изменённым файлам. Вызывается внутри `executeStep` после Coder, до Reviewer (до 2 Fixer-попыток). Ловит parse/type ошибки раньше LLM-judge'а (G1). Fail-fast на `codeChanges.files.length === 0` — эмитирует `step_noop` SSE event и бросает (G2). `executePlanParallel` накапливает `stepFailures: Map<string,string>` — "All N steps failed" теперь включает `"Step s1: <reason>"` (G3). `FEATURE_SPEC.pruneHistory: false→true` — устранён context overflow (36k tokens). `.js` суффикс в FEATURE_SPEC пример + TS2307/TS2339 паттерны в BUGFIX_SPEC. **+4 mock-based unit-tests TypeChecker.runOn, 530/530.**

**Модель:** `LLM_LARGE_MODEL=gemma` → `gemma-4-26b-a4b-it-mxfp4-moe-ctx-32k-q8-0-kv-t07`. Gemma 4 генерирует корректный TypeScript с правильными Fastify паттернами (module augmentation для request extension, query typing) — qwen-coder-32b стабильно давал type errors на тех же задачах. `qwen-coder-32k` добавлен в llama-swap config (32k ctx, q4_0 KV cache, flash-attn).

**Bench (2026-05-10–11, sandbox 6 файлов):**
- baseline qwen-coder-long: **0/8** ✅/commits → v1.35 qwen-coder-32k: **2/8** → Gemma: **7/8** ✅ (AC4 закрыт)
- false-positives (completed + bad code): **2→0**; no-ops (0 changes): **2→0**
- L3.x (Gemma, 3 задачи, 3-5 файлов): **1/3** — Reviewer как блокер на архитектурных задачах
- Design: [v1.35-coder-reviewer-fix.md](docs/designs/v1.35-coder-reviewer-fix.md)
- Bench L2.x: [2026-05-10-v1.35-l2x-rerun.md](docs/benchmarks/runs/2026-05-10-v1.35-l2x-rerun.md), [2026-05-11-v1.35-gemma-l2x.md](docs/benchmarks/runs/2026-05-11-v1.35-gemma-l2x.md)
- Bench L3.x: [2026-05-11-v1.35-gemma-l3x.md](docs/benchmarks/runs/2026-05-11-v1.35-gemma-l3x.md)

---

## v1.34.1 — Release prep: BUGFIX_SPEC fix + GitHub docs + .vsix (2026-05-08)

BUGFIX_SPEC `WORKFLOW` шаг 2 расширен до 4-шагового алгоритма для тест-фейлов: (a) читаем тест → (b) идём по импортам → (c) ищем object literal → (d) добавляем **значение** (`field: value`), а не тип-аннотацию. Новый паттерн в `COMMON TS PATTERNS`: `as SomeType` не добавляет данные — только `field: value` в литерале. Адресует L4.1 r1 регрессию (Coder писал `} as User` без `createdAt`, Fixer в 3-х попытках повторял ту же аннотацию). **530/530 тестов (без изменений). Bench v1.34.1 L4.1 ×3 = 3/3 ✅ (r1: 285s, r2: 60s, r3: 110s — все byte-perfect).**

GitHub docs: README переписан на английский (user-facing: what it does, one-paragraph architecture, llama-swap quickstart, known limitations). Добавлены `LICENSE` (MIT) и `CONTRIBUTING.md`. Extension package.json: добавлены `repository` и `license` поля. `packages/vscode-extension/LICENSE` добавлен. `*.vsix` в `.gitignore`.

.vsix: `npm run build` + `vsce package` — 29KB, 18 файлов, 0 предупреждений. Установлен через `code --install-extension`. Бандл верифицирован (все ключевые символы присутствуют).

## v1.34 — Hybrid search: BM25 + dense RRF (2026-05-08) — Phase 4 вторая итерация

Pure-TS `BM25Index` (k1=1.5, b=0.75) поверх symbol bodies + path components. RRF merge (`k=60`) dense + BM25 в `GraphRetriever.retrieveContextItems()`. Kill-switch `RAG_BM25_ENABLED` (default true), `RAG_BM25_CANDIDATES` (default 30). `indexCodebase` исключает `data/backups/**`. `loadFromDisk` перестраивает BM25 из CodeGraph (no extra persistence). `chat_template_kwargs: {enable_thinking: false}` во все LlamaSwapClient request bodies (Qwen3 fix). `interceptToolCall` hook в BUGFIX_SPEC — hard veto `create_file` на test paths (L4.1 Fixer regression fix). `git-engine` теперь использует `config.git.defaultBranch` вместо hardcoded `'main'`. **+16 BM25 unit-tests + 5 interceptToolCall tests, 530/530 (было 507).**

**Bench v1.34 (2026-05-08, sandbox 5 файлов):**
- L1.1 ×3 = **3/3** ✅ (regression guard; avg 77s; `/health` route correctly placed)
- L4.1 ×3 = **2/3** ✅ (interceptToolCall сработал — Fixer ни разу не создал тест-файл; r1: incomplete fix — модель добавила type annotation без `createdAt` value → validation loop, no commit)
- L2.1/L2.2 на target — не запущены (context overflow 91-файлового target'а при 16K лимите; отдельная задача)
- Infrastructure fixes в этой сессии: bench script field names, Qwen3 thinking mode, git-engine defaultBranch
- Design: [v1.34-hybrid-search.md](docs/designs/v1.34-hybrid-search.md)
- Bench: [2026-05-08-v1.34-hybrid-search.md](docs/benchmarks/runs/2026-05-08-v1.34-hybrid-search.md)

## v1.33 — BGE-reranker two-pass retrieval (2026-05-07) — Phase 4 первая итерация

HNSW(k=30) → BGE-reranker-v2-m3 → top-5 в `GraphRetriever.retrieveContextItems()`. Kill-switch `RAG_RERANKER_ENABLED` (default false). Graceful fallback при reranker error. **+8 unit-tests, 507/507 (было 499).** LlamaSwapClient.rerank() → POST /v1/rerank, сортировка DESC по relevance_score.

**Bench v1.33 (2026-05-07, precision@5 A/B на rag-system-target 91 файл):**
- L1.1 ×3 = 2/3 ⚠️ (r1: empty commit hash после nudge; r2+r3: yes, server.ts)
- L1.2 ×3 = 2/3 ✅ AC4 met (первый baseline; r1+r2: Zod schema + safeParse; r3: Fixer loop failed)
- L1.3 ×3 = 3/3 ✅ AC4 met (первый baseline; 96–112s, стабильно)
- L4.1 ×3 = **1/3 ❌** (регрессия от 3/3; Fixer создаёт тест-файлы вместо фикса в r1+r3)
- L2.1 precision@5 baseline: 0/3 → reranker: 0/3 (server.ts не в top-30 HNSW кандидатах — vocabulary gap)
- L2.2 precision@5 baseline: 0/3 → reranker: 0/3 (routes/schemas не в top-30)
- Reranker работает (порядок файлов изменился), но не решает fundamental recall miss → нужен BM25 (v1.34)
- Выявлена: backup-файлы в индексе (data/backups/**), L4.1 Fixer нестабильность
- Design: [v1.33-reranker.md](docs/designs/v1.33-reranker.md)
- Bench: [2026-05-07-v1.33-reranker.md](docs/benchmarks/runs/2026-05-07-v1.33-reranker.md)

## v1.32-c.1 — no-progress nudge before done() (2026-05-05) — Phase 3 fully closed

Перехват преждевременного `done()` в `runTaskAgent`: когда `successfulEdits === 0` (loop видел только errors + read_file), одно `NO_PROGRESS_NUDGE` сообщение блокирует выход и предлагает `replace_in_file` fallback. Вторая попытка `done()` всегда пропускается (cap=1). **+6 unit-tests, 499/499 (было 445+54).** Также: `llamaswap-client.ts` — добавлен `max_tokens: 4096` во все три request bodies (defensive fix для thinking-mode моделей вроде qwen3).

**Re-bench v1.32-c.1 (2026-05-05, qwen3 Planner + qwen-coder-long Coder/Fixer):**
- L1.1 ×3 = **3/3** ✅ (было 2/3; nudge fired on r1: Coder intercepted add_route error → committed via server.ts)
- L4.1 ×3 valid = **3/3** ✅ (было 3/5=60%; nudge fired all 3: Fixer → byte-perfect fix each)
- L3.1 ×1 = **byte-perfect**, 61s (no regression)
- Design: [v1.32-c.1-no-progress-nudge.md](docs/designs/v1.32-c.1-no-progress-nudge.md)
- Bench: [2026-05-05-v1.32-c.1-no-progress-nudge.md](docs/benchmarks/runs/2026-05-05-v1.32-c.1-no-progress-nudge.md)

## v1.32-d — llama-swap backend swap (2026-05-02) — Phase 3 closure

Замена `OllamaClient` на `LlamaSwapClient` (OpenAI-compatible API), default `LLM_BACKEND=llamacpp`. Ollama сохранён как fallback. **Phase E bench:** L1.1 ×4 (3/3 commits, mean 101s, ~50% faster than Ollama), L4.1 ×3 (1/3 clean fix, parity). **Phase F flipped:** `LLM_BACKEND=llamacpp`, `LLM_LARGE_MODEL=qwen-coder-long` (16K), `TOOL_CALLING_CODER=true` дефолты. **+34 unit-tests, 445/445.**
- v1.32-d.1 — `mergeFixerChanges` fix (Coder edits сохраняются когда Fixer трогает subset)
- nomic-embed-text-v1.5 task-prefixes (`search_query:` / `search_document:`) wired backend-agnostic
- **Design:** [v1.32-d-llamacpp-backend.md](docs/designs/v1.32-d-llamacpp-backend.md)
- **Bench:** [2026-05-02-v1.32-d-llamacpp-backend.md](docs/benchmarks/runs/2026-05-02-v1.32-d-llamacpp-backend.md)

## v1.32-c — Task-agents over shared loop (Phase A+C, 2026-05-02)

Унифицированный `runTaskAgent(spec, input)` loop в [packages/agents/src/task-agents/](packages/agents/src/task-agents/) с тремя specs: `FEATURE_SPEC`, `BUGFIX_SPEC`, `REFACTOR_SPEC`. Specialization через prompts + tool selection, не отдельные классы. Phase B (bench) выполнена retro-active 2026-05-04: **L1.1 ×3 = 2/3, L3.1 ×3 = 3/3 byte-perfect, L4.1 ×5 = 3/5 (все 3 commits byte-perfect, healthy median ~3× быстрее v1.32-d)**. AC4 met; AC3+AC5 commit-rate 1 short — surface'или **done-after-structural-error pattern** → tractable v1.32-c.1 follow-up.
- **Design:** [v1.32-c-sub-agents.md](docs/designs/v1.32-c-sub-agents.md)
- **Bench:** [2026-05-04-v1.32-c-task-agents.md](docs/benchmarks/runs/2026-05-04-v1.32-c-task-agents.md)

## v1.32-a.6 — Prettier post-step (2026-04-30)

`prettier --write` запускается на `writtenFiles` после validation pass и до commit. **Cosmetics-only — никогда не блокирует commit.** Детект через `.prettierrc*` / `prettier.config.*` / package.json `"prettier"` field; только локальный `node_modules/.bin/prettier`, никаких npx fallback. **+15 тестов, 441/441.** Empirical verify (retro-active 2026-05-04, prettier-configured sandbox): wiring fired 3/3 commits, no wall-time regression, no failure modes triggered.
- **Атакует:** v1.32-a.4 finding — 4/5 runs landed с cosmetic style noise (indent, blank lines, trailing commas)
- **Bench:** [2026-05-04-v1.32-a.6-prettier.md](docs/benchmarks/runs/2026-05-04-v1.32-a.6-prettier.md)

## v1.32-a.5 — Coder/Fixer pathology guard (2026-04-30)

Detection "stuck on same `tool:path` tuple": после `PATHOLOGY_THRESHOLD=5` repeated errors → strategy nudge; после `MAX_PATHOLOGY_STRIKES=2` → hard bail. **Wall-time bounded 23 min vs 58 min** (v1.32-a.4 outlier). **+5 тестов, 392/392.**
- **Bench:** [2026-04-30-v1.32-a.5-pathology-guard.md](docs/benchmarks/runs/2026-04-30-v1.32-a.5-pathology-guard.md)

## v1.32-a.4 — L4.1 robustness ×5 (2026-04-30)

5/5 commits land, 0/5 destructive failures, 0/5 Fixer-bail. Median wall 6 min, 1/5 byte-perfect, 3/5 minor style noise (→ v1.32-a.6), 1/5 structural noise (dead code). **Variance moved to QUALITY layer, не CORRECTNESS.**
- **Bench:** [2026-04-30-v1.32-a.4-l4.1-robustness.md](docs/benchmarks/runs/2026-04-30-v1.32-a.4-l4.1-robustness.md)

## v1.32-a.3 — Fixer reliability + Coder retry symmetry (2026-04-30)

Consolidated FIXER_SYSTEM_PROMPT (~40 → ~20 строк); no-tool-calls retry с прогрессивно strong nudges, bail только на 3-м consecutive text-only response. **L4.1 first end-to-end committed bug-fix (commitHash 8319157, ~7 min wall).** **+5 тестов, 387/387.**
- **Bench:** [2026-04-30-v1.32-a.3-fixer-reliability.md](docs/benchmarks/runs/2026-04-30-v1.32-a.3-fixer-reliability.md)

## v1.32-a.2 — Orchestrator commit-aggregation (2026-04-30)

`runValidationLoop` возвращает `{ passed, issuesCount, writtenFiles }` — Fixer's writes аппендятся в outer `writtenFiles` set. Лечит: validation passed → "Committed changes" с empty hash → git status показывал uncommitted file. **+2 тестов, 382/382.**
- **Bench:** [2026-04-30-v1.32-a.2-commit-aggregation.md](docs/benchmarks/runs/2026-04-30-v1.32-a.2-commit-aggregation.md)

## v1.32-a.1 — Read-grants-write (2026-04-30)

`read_file(p)` в текущем loop'е grant'ит write permission to `p` — deliberate чтение становится transparent scope-acquisition gesture. Fixer test-path forbidden закрывает loophole (read test → silence assertion). **L4.1 byte-perfect fix в working tree (orchestrator commit-bug → v1.32-a.2).** **+18 тестов, 380/380.**
- **Bench:** [2026-04-30-v1.32-a.1-read-grants-write.md](docs/benchmarks/runs/2026-04-30-v1.32-a.1-read-grants-write.md)

## v1.32-a — Fixer test-scope discipline (2026-04-29)

`buildFixerAllowedSet` отбрасывает test-paths из issue-mention pool unless Coder touched them. **Test-gaming impossible:** L4.1 commit_skipped (correct red signal) vs v1.31.2 broken commit landed. **+6 тестов, 362/362.**
- **Bench:** [2026-04-30-v1.32-a-fixer-test-scope.md](docs/benchmarks/runs/2026-04-30-v1.32-a-fixer-test-scope.md)

## v1.31.2 — Bench coverage extension (2026-04-29)

L3.1 byte-perfect (Coder fell back на replace_in_file для object-literal — validates negative case). **L4.1 critical finding:** Coder modified test вместо production code → green commit с broken bug shipped. Surface'ил semantic gap для navigational tasks. → v1.32-a.
- **Bench:** [2026-04-30-v1.31.2-bench-coverage-extension.md](docs/benchmarks/runs/2026-04-30-v1.31.2-bench-coverage-extension.md)

## v1.31.1 — Validation prompt-fixes (2026-04-29)

L1.1 failure rate 50% → 0%. L2.1 duplicate-register absent. Fixer empty-names `add_import` 8 → 0 (20+ named). Mid-v1.31 prompt fixes (line-shift warning + Fixer add_import names) validated empirically.
- **Bench:** [2026-04-30-v1.31.1-prompt-fixes.md](docs/benchmarks/runs/2026-04-30-v1.31.1-prompt-fixes.md)

## v1.31 — Structural anchor edits (2026-04-29)

6 новых AST-aware tools: `add_method`, `replace_method`, `replace_function`, `add_route` (Fastify-aware), `add_import`, `add_export`. Заменяют line-coord `replace_in_file` для TS/JS edits. **`/version` → byte-perfect через `add_route` за 3 calls / 12 min** (vs 25 calls / 32 min на v1.30.5). `getSize()` placed INSIDE class by construction (vs OUTSIDE на v1.30). **+62 тестов, 356/356.**
- **Bench:** [2026-04-30-v1.31-structural-anchors.md](docs/benchmarks/runs/2026-04-30-v1.31-structural-anchors.md)

## v1.30.5 — Verify-syntax tool после replace_in_file (2026-04-29)

`checkBraceBalance` (string/comment-aware) до и после replace; на дисбаланс → atomic undo через `WorkingSet.overwriteRaw`. **`/version` task завершилась без Ollama crash на 91-файловом проекте впервые** (graduated с `task_failed` infra layer на `commit_skipped` output quality layer). **+14 тестов, 294/294.**
- **Bench:** [2026-04-29-v1.30.5-verify-syntax.md](docs/benchmarks/runs/2026-04-29-v1.30.5-verify-syntax.md)

## v1.30.4 — Coder cargo-cult fix (2026-04-29)

Prompt section "CONTENT COMES FROM THE TASK DESCRIPTION — NOT FROM SIBLING CODE". `/version` впервые вернул correct `{ version: '1.0.0' }` (vs клоны /health body). Surface'ил структurную failure (consumed closing brace) → v1.30.5.
- **Bench:** [2026-04-29-v1.30.4-cargo-cult-fix.md](docs/benchmarks/runs/2026-04-29-v1.30.4-cargo-cult-fix.md)

## v1.30.3.1 — Fixer history truncation (2026-04-29)

`pruneHistory` keeps `system + initial user task + last 16 trail messages`; `MAX_TOOL_CALLS` 50 → 25. **First Fixer attempt completed без crash на 91-файловом проекте (~2 min vs 8 min crash).** **+6 тестов, 280/280.**
- **Bench:** [2026-04-29-v1.30.3.1-fixer-history-pruning.md](docs/benchmarks/runs/2026-04-29-v1.30.3.1-fixer-history-pruning.md)

## v1.30.3 — Fixer migration to tool-calling (2026-04-29)

`ToolCallingFixerAgent` с issues-first signature; `buildFixerAllowedSet(currentFiles, issues)` — union paths из Coder output И mentions в error messages. Coder-Fixer работают только в lockstep (один флаг). **Live tests crashed Ollama (~7-8 min)** — pattern reproducible, infra ceiling под длинными tool-calling sessions. → v1.30.3.1. **+6 тестов, 274/274.**
- **Bench:** [2026-04-29-v1.30.3-tool-calling-fixer.md](docs/benchmarks/runs/2026-04-29-v1.30.3-tool-calling-fixer.md)

## v1.30.1 — Scope discipline в tool-calling Coder (2026-04-29)

`extractAllowedPaths(taskDescription)` + `ALWAYS_FORBIDDEN_PATTERNS` (package.json, lockfiles, configs). **Scope creep устранён:** `/version` task на v1.30 wiped package.json + создал vitest-setup.ts; на v1.30.1 — ТОЛЬКО server.ts. **+14 тестов, 268/268.**
- **Bench:** [2026-04-29-v1.30.1-scope-discipline.md](docs/benchmarks/runs/2026-04-29-v1.30.1-scope-discipline.md)

## v1.30 — Tool-calling Coder (2026-04-29) — Phase 3 entry

5 tools (`read_file`/`replace_in_file`/`create_file`/`delete_file`/`done`); `WorkingSet` с lazy disk read; `chatWithTools` с inline-content fallback parser для qwen2.5-coder/gemma2 quirk (tool calls в `content`, не structured). **v1.29 scale ceiling сломан:** rag-system /version 0/10 → 5.2/10 (server.ts surgical edit). `TOOL_CALLING_CODER=true` opt-in (стал дефолт в v1.32-d). **+31 тест, 254/254.**
- **Bench:** [2026-04-29-v1.30-tool-calling-coder.md](docs/benchmarks/runs/2026-04-29-v1.30-tool-calling-coder.md)

## v1.29.1 — Repo-map at scale (2026-04-29)

`DEFAULT_MAX_BYTES` 6K → 16K (~4K tokens); `isTestFile` helper; render order highlights → production → tests. **rag-system-target (91 файл): production truncated 60% → 10%, tests явно отделены, scope-creep risk low.** **+4 теста, 223/223.**

## v1.29 — Scale validation на rag-system (2026-04-29) — Phase 3 trigger

Bench на 91-файловом TS проекте (65 with symbols, 6717 LOC). Indexing 3.5s / 210 vectors — OK. **Atomic L1' `/version`: 0/10** (5 search-not-found cascades — patch-based Coder hallucinates search блоки на medium scale). **Phase 3 archtectural shift necessary** (→ tool-calling).
- **Bench:** [2026-04-29-v1.29-scale-rag-system.md](docs/benchmarks/runs/2026-04-29-v1.29-scale-rag-system.md)

## v1.28 — Silent partial completion events (2026-04-29)

Новый event `commit_partial` между `commit_skipped` и `done`. Tracks `unrecoveredWrites: string[]`; `done.data` расширен `{ partial, failedStepIds, unrecoveredWrites }`. Pure observability — UX win, бенчмарк scores не двигает. **+2 теста, 219/219.**

## v1.27 — Per-agent context tailoring (PARTIAL — 2026-04-29)

**✅ Landed:** Planner few-shot examples (multi-file feature → ОДИН step coupled). **❌ Reverted после empirical regression:** lean Architect/Reviewer/Tester context — wall time 3-5× медленнее, L2.1 variance взорвалась `[10, 1]`. Architect's `design` field load-bearing для Coder. → orchestrator revert'нут к v1.26 контекстам.
- **Bench:** [2026-04-29-v1.27-per-agent-context.md](docs/benchmarks/runs/2026-04-29-v1.27-per-agent-context.md)

## v1.26 — Few-shot examples в Coder/Fixer (2026-04-29)

Worked examples (input → output) вместо абстрактных prose rules. **L2.1 lifted from variance hell to deterministic 10/10** (mean 6.4 → 10.0, обе попытки byte-identical к Example A). L2.3 cumulative: 6.8 partial + 9.0 GREEN, no commit_skipped. Mean across 6 runs: 9.3/10.
- **Bench:** [2026-04-29-v1.26-few-shot.md](docs/benchmarks/runs/2026-04-29-v1.26-few-shot.md)

## v1.25 — Repo-map в каждом промпте (2026-04-28) — главный структурный шаг Phase 2

`buildRepoMap(graph, projectRoot, opts?)` с per-file relative path + indented signatures, token budget (default 6000 chars), `highlightFiles` (entry points + previousChanges paths) pinned at top. Рендерится **вторым** блоком промпта между Project Conventions и Recently-modified. **L2.3 cumulative впервые landed GREEN 9.2/10** (прежний потолок 5.0/10 partial commit).
- v1.25.1 — Validation-Fixer write throws не крашат task (try/catch + log)
- v1.25.2 — Reindex прунит graph по deleted files (атакует "ghost files" в repo-map)
- **Bench:** [2026-04-28-v1.25-repo-map.md](docs/benchmarks/runs/2026-04-28-v1.25-repo-map.md)

## v1.24 — Whitespace-tolerant edit matching (2026-04-28)

`applyEdits` strict-first → tolerant fallback с `\s+`-нормализацией; `tolerantEdits: number[]` в ApplyResult. Tolerant требует уникального match (zero / ≥2 → abort). Whitespace-only guard. Insurance policy — на бенчмарках ни разу не сработал, false-positive отсутствуют. **+9 тестов.**
- **Bench:** [2026-04-28-v1.24-whitespace-tolerant.md](docs/benchmarks/runs/2026-04-28-v1.24-whitespace-tolerant.md)

## v1.23 — Patch-based code editing (search/replace blocks) (2026-04-27) — главный safety win

`FileChange` discriminated union (`create | modify | delete`); для modify — массив `edits: Array<{search, replace}>`, нет `content`. `applyEdits()` zero/multiple matches → abort, atomic. **Файл никогда не разрушается, даже при неверном edit. Main защищён.** L2.1 на qwen2.5-coder:32b → 10/10 GREEN.
- v1.23.1 — entry-point файлы (server.ts/main.ts) всегда в ragFilePaths
- v1.23.2 — `dedupeChangesByPath` (modify edits сливаются в одно atomic apply)
- v1.23.3 — retry-with-real-content (Aider iterative editing pattern)
- **+10 тестов, 196/196.** Cumulative state регрессирует на всех 3 моделях — фундаментальное ограничение, не лечится правилами.
- **Bench:** [2026-04-27-v1.21-v1.23-multi-model.md](docs/benchmarks/runs/2026-04-27-v1.21-v1.23-multi-model.md)

## v1.22 — Cross-step consistency & prompt hardening

`previousChanges: FileChange[]` snapshot для executeStep; новый блок "Recently modified by previous steps (CURRENT state — SUPERSEDES Existing project files)". Coder/Fixer prompts усилены правилом приоритета над диском.
- v1.22.1 — Planner rule: same-file sequential dependencies
- v1.22.2 — `const` exports indexing (`export const X = {...}` теперь попадают в RAG)
- v1.22.3 — Coder rules 9-13 (entry-point preservation, no `require()` в ESM, file extension rule, Fastify quick reference); Tester explicit vitest mocking guide

## v1.21 — Context fidelity & reliability (working baseline)

`ProjectConventions` модуль (testFramework, moduleType, tsStrict, runtimeFrameworks, entryPoints). `buildPromptContext` с 4 секциями. **`COMMIT_ONLY_IF_VALID=true`** — git коммит только при passing validation. **`TESTER_ENABLED`** flag (default true, но в проде часто false из-за jest-style моков). `PLANNER_MAX_STEPS=50` hard cap. Critical bugfixes: glob ignored node_modules в sandbox; Validator на неверном projectRoot.

## v1.18 — VSCode Extension

12-й пакет монорепо, esbuild → `dist/extension.js` (~18 KB). Activity bar с двумя TreeView (Projects, Tasks); status bar с активным проектом; команды Run Task / Index / Register Project / Stream Progress; OutputChannel "RAG System" форматирует SSE events; polling /tasks каждые 5с. **Новый API endpoint** `POST /index { project?, root? }`. **+12 тестов.**

## v1.17 — Streaming Coder

`BaseAgent.streamLLM` AsyncIterable; `partial-json.ts` string-aware scanner с поддержкой markdown fence; `CoderAgent.execute(..., onFileReady?)` callback срабатывает на каждом готовом файле. Новый event `coder_file_ready { stepId, path, action, size, index }`. **+14 тестов.**

## v1.16 — MCP проекты

MCP server использует тот же `ProjectRegistry`+`ProjectManager` что API. Новые tools: `list_projects`, `register_project`. Optional `project_id` на index_codebase / search_code / get_related_code / run_task / list_decisions / add_decision.

## v1.15 — Multi-project

`Project` модель + `ProjectRegistry` (top-level SQLite в `data/projects.db`). `projectPaths(project)` — изолированный layout `data/projects/<id>/{memory.db, vectors/, graphs/, backups/}`. `ProjectManager` lazy lifecycle. API endpoints: GET /projects, GET /project/:id, POST /project. **+23 тестов.**

## v1.14 — Live прогресс индексации

Events `index_start | index_file | index_skip | index_done` на канале `task:<indexId>`. Throttle 200мс. MCP `index_codebase` возвращает indexId + URL стрима. **+5 тестов.**

## v1.13 — Tolerant JSON parsing

`tryParseJsonTolerant<T>` strict-first → 6 фиксеров (BOM, code-fence, extract-from-prose, comments, trailing-commas, escape-control-in-strings). Каждый фиксер string-aware. **+15 тестов.**

## v1.12 — Параллельная индексация файлов

`Semaphore` (FIFO, counting); `embedWithCache` оборачивает только сетевой round-trip; `indexCodebase` использует pMap(files, fileConcurrency). `FILE_CONCURRENCY=4`, `EMBED_CONCURRENCY=8` дают ~5-8× speedup на холодном кеше.

## v1.11 — Параллельный embed

`pMap(items, n, mapper)` sliding-window pool в graph-retriever. `EMBED_CONCURRENCY=8` default. Cache-хиты не держат слот.

## v1.10 — Streaming агентов

`OllamaClient.chatStream()` AsyncIterable с NDJSON-парсером; `BaseAgent.callLLM` теперь streaming внутри (аккумулирует для backwards compat). `AsyncLocalStorage` контекст задачи (taskId/stepId через 5 слоёв без изменения сигнатур). Event `agent_stream` throttle 120ms.

## v1.9 — DAG-aware параллелизм Orchestrator

Независимые шаги идут одновременно через `Promise.race`. `AGENTS_PARALLELISM=3` default. `detectCycles()` итеративный DFS. Dangling deps → шаг помечается skipped.

## v1.8 — Наблюдаемость

`taskLogger(taskId)` pino.child с тaglинe taskId. `BackupManager.prune(maxAgeMs)` — `BACKUP_MAX_AGE_DAYS=7` default. setInterval с `unref()`.

## v1.7 — MCP resources + prompts

Resources: `adr://recent`, `adr://{id}`, `failures://top`, `tasks://recent`. Prompts: `add-feature`, `fix-bug`, `refactor`, `add-tests` — модель учится на прошлых ошибках через MCP. **+14 тестов.**

## v1.6 — Полиглот

tree-sitter (0.25) + python/rust/go в `@rag-system/code-graph`. `ASTParser` диспетчер по расширению. Lazy load с graceful degradation. **+6 тестов на 4 языках.**

## v1.5 — Live progress (SSE)

`TaskEventBus` (EventEmitter + ring buffer 200 событий). Orchestrator эмитит `plan | step_start | step_complete | step_fail | step_skip | validation_* | commit | done`. `GET /task/:id/stream` — SSE с replay history → live → close. Heartbeat 15с.

## v1.4 — Live indexing

FileWatcher (chokidar) с дебаунсом 1500ms — автопереиндексация при сохранении в IDE. Очистка удалённых файлов из CodeGraph + VectorStore (`HNSW.markDelete`) + file_hashes. `WATCH_ENABLED=true` flag.

## v1.3 — Resilient orchestration

Per-step error recovery — упавший шаг не убивает задачу. DAG-aware skip — шаги с упавшими зависимостями автоматически пропускаются. Partial completion в `tasks.result`. ADR + failure pattern на каждый сбой.

## v1.2 — Качество агентов

TestRunner (`npm test` после write с таймаутом). TypeChecker (`tsc --noEmit`). Validation loop в Orchestrator — Fixer получает реальные ошибки tsc/тестов. Embedding cache в SQLite (sha1 dedup).

## v1.1 — Reliability baseline

Zod-валидация вывода всех агентов (защита от кривого JSON от LLM). VectorStore async mutex + атомарная запись (.tmp + rename). Promise.allSettled в RAG loader. SQLite close() при graceful shutdown. validateConfig() при старте. vitest + 35 тестов. Инкрементальная индексация (SHA-1 хеши). MCP runtime-валидация. Fastify bodyLimit (64KB) + rate-limit (60 req/min).

## v1.0 — Foundation (Iter 0–3)

**Iter 0:** Turborepo monorepo, 12 пакетов, package.json/tsconfig/turbo.json, npm install + npm run build clean.
**Iter 1:** Core — shared/types/config/logger; OllamaClient (`/api/chat`, `/api/embeddings`, healthCheck); MemoryStore (SQLite, tasks/adr/failures); SafeWriter + BackupManager + DiffEngine; MemoryQueue + JobWorker (graceful shutdown); Fastify API (/health, /task, /task/:id, /tasks).
**Iter 2:** RAG Engine — ASTParser (TS Compiler API: function/class/interface/type), CodeGraph с персистентностью; VectorStore (HNSW, cosine, labelMap); GraphRetriever (embed → search → 1-hop deps → token-bounded context); подключение к Orchestrator.
**Iter 3:** MCP server — stdio transport, 7 tools (index_codebase, search_code, get_related_code, run_task, get_task_status, list_decisions, add_decision); .vscode/mcp.json + .roo/mcp.json.
