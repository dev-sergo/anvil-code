# Benchmark

Quantitative track record of Anvil-Code on TypeScript codebases. Methodology is reproducible; raw run files live in [docs/benchmarks/runs/](docs/benchmarks/runs/) — one file per iteration so regressions show up in `git diff`.

## TL;DR

| Target                | Size           | Tasks | Success | Notes                          |
|-----------------------|----------------|-------|---------|--------------------------------|
| `rag-system-sandbox`  | 30 TS files    | 16    | **87.5 %** (14/16) | Curated suite L1–L5, all categories |
| `honojs/hono`         | 366 TS files   | 6     | **100 %** (6/6, v1.47 Gemma + v1.68c Qwen3) | H4 bench setup error fixed; real capability 6/6 |
| `trpc/trpc`           | 907 TS files   | 6     | **100 %** (6/6, v1.68c — T2 requestTimeout closed) | pnpm monorepo, project refs |
| **Combined real-repo** | | **12** | **100 % (12/12)** | v1.68c best; v1.70 re-run 8/12 (model variance) |

Sandbox numbers measure code-generation ceiling. Real-repo numbers measure operational ceiling. Combined **42 % → 100 %** improvement from v1.38 → v1.68c. The v1.70 re-run scored 8/12 (67%) — T2/T3/T6 fell to model variance; H6 hit a commit-completeness bug (test only, no impl). Best-effort ceiling remains 12/12.

Additional bench categories (v1.39+):
- **Cumulative mode** (sequential tasks accumulating in `auto/cumulative`): **6/6** on sandbox.
- **L6 large-file surgery** (overload disambiguation, property arrows): **3/4** on hono files >480 LOC.
- **Cross-repo** (new repo without training exposure): zod **4/4** after v1.51 extension detection; vite **6/6 ✅** (v1.63, Qwen3-35B MoE — all tasks including 1835-line file modification and large-file navigation).

**API pre-flight workflow** (v1.52): `GET /project/:id/healthcheck` returns `{ready, tscOk, testsOk, issues[]}` — verify environment before bench.

---

## Methodology

### Suite

Tasks are stored in [docs/benchmarks/tasks.md](docs/benchmarks/tasks.md), organized by level:

- **L1 — atomic** (single file, no new abstractions)
- **L2 — multi-file additive** (new endpoint + new service)
- **L3 — refactor** (rename, extract, restructure)
- **L4 — bugfix** (failing test as input, find + fix the bug)
- **L5 — comprehensive** (mixed categories, A/B/C/D = additive/structural/algorithmic/maximum)

Same descriptions every run, so results are comparable across iterations.

### Run protocol

For each iteration:

1. Spawn a fresh run file from [runs/_template.md](docs/benchmarks/runs/_template.md), named `YYYY-MM-DD-<tag>.md`.
2. Lock the configuration block — model, env, code revision.
3. Reset target to a known baseline (`git checkout main`, prune `auto/*` branches).
4. For each task: submit via `POST /task`, wait for `done`/`error`, capture plan size, files touched, validation result, commit hash, and a diff snippet.
5. Score each result 0–10 across 5 axes (see below). Average across axes is the task score; average across tasks is the run score.
6. Write the lessons-learned section before closing the file.

### Scoring axes

| Axis           | What it measures                                              |
|----------------|---------------------------------------------------------------|
| Correctness    | Typecheck passes, tests pass, runtime semantics match the task |
| Architecture   | Touched only what was needed, no parallel duplicates           |
| Style          | Project conventions (framework, imports, naming, indentation) |
| Completeness   | Every part of the task description addressed                  |
| Idiomatic      | What a senior engineer would write                            |

A `commit` event with a passing validation loop is required for "success". `commit_skipped` (validation never converged) and `commit_partial` (some steps failed) both count as failures in headline numbers.

---

## Results — Sandbox (v1.37, May 2026)

Curated suite on `rag-system-sandbox` (Fastify users API, 6 production files + 30 supporting). Run file: [2026-05-11-v1.37-l5x-comprehensive.md](docs/benchmarks/runs/2026-05-11-v1.37-l5x-comprehensive.md).

Configuration:

| | |
|---|---|
| `LLM_LARGE_MODEL` | `gemma` (gemma-4-26b-a4b-it-mxfp4-moe-ctx-32k) |
| `LLM_SMALL_MODEL` | `qwen3` |
| `RAG_MAX_CONTEXT_TOKENS` | 3000 |
| `TOOL_CALLING_CODER` | true |
| Mode | `balanced` |

By category:

| Category | Tasks | Pass | Notes |
|---|---|---|---|
| A — Additive (new file / new endpoint)   | 6 | **6/6**  | 100 % |
| B — Structural (extract / generic class) | 4 | **4/4**  | 100 % |
| C — Algorithmic (LRU, TTL, SSE)          | 3 | **3/3**  | 100 % |
| D — Maximum (CQRS, multi-file SSE)       | 3 | **1/3**  | Reviewer correctly blocked the genuine CQRS attempt |
| **Total**                                | **16** | **14 (87.5 %)** | |

Quality observations from passing runs:

- **D1 SSE** — generated `Set<subscriber>`, `writableEnded` guard, `request.raw.on('close')` cleanup. Idiomatic.
- **C1 LRU** — correct Map eviction (delete + re-set for order), hit/miss tracking.
- **C3 token TTL** — correct expiry, Bearer header parsing.
- **B3 Store&lt;T extends {id}&gt;** — proper generic constraint, type-narrowed lookups.
- **A2 tags** — new service + cross-file integration (route registration + handler).

Failure modes seen on the 2 misses:

- **D2 CQRS split** — Reviewer rejected 3× because the proposed split introduced circular event dependencies. Correct call.
- **D1 on the 94-file `rag-system-target`** — `RAG_MAX_CONTEXT_TOKENS=3000` was insufficient to surface the full `taskEvents` architecture. Out-of-budget retrieval.

---

## Results — Real OSS repositories (v1.38, May 2026)

The honest test: drop the agent into a codebase it's never seen.

### Sprint Day 1 — baseline (`67562de` parent)

Goal: catalogue failure patterns on unmodified `honojs/hono` (326 files) and `trpc/trpc` (714 files).

Run file: [2026-05-12-real-repo-diagnostic.md](docs/benchmarks/runs/2026-05-12-real-repo-diagnostic.md).

**Result: 0/18 commits.**

| Pattern                  | hono | trpc | Total | %     |
|--------------------------|------|------|-------|-------|
| `exceed_context_size`    | 3    | 3    | 6     | 33 %  |
| `test_fail:snapshot`     | 4    | 0    | 4     | 22 %  |
| `ts_precheck_fail`       | 0    | 3    | 3     | 17 %  |
| `validation_fail:ts`     | 1    | 1    | 2     | 11 %  |
| `reviewer_reject`        | 1    | 1    | 2     | 11 %  |
| `llm_parse_fail`         | 0    | 1    | 1     | 6 %   |

The diagnostic separated *system bugs* (`Promise.race([])` hang on synchronously skipped steps, pre-existing test failures counted as regressions) from *capability limits* (32 K ctx insufficient for hono's middleware graph).

### Sprint Day 2 — after fixes

Six targeted fixes shipped in commit `67562de`:

| Fix                                                          | Pattern targeted        |
|--------------------------------------------------------------|-------------------------|
| `Promise.race([])` hang on synchronously skipped steps       | bug — eliminated        |
| Baseline detection: compute tsc+test failures on a clean repo before the first task; filter pre-existing from validation | `ts_precheck_fail`, `test_fail:snapshot` |
| `MAX_READ_LINES=350`, `HISTORY_KEEP_TAIL=4`                  | `exceed_context_size`   |
| `repo-map` budget tightened to 5 K bytes, prompt-context 10 K | `exceed_context_size`   |
| RAG-retrieved paths are read-only for the Coder              | `test_fail:snapshot` (destructive side-effect rewrites) |
| `runValidationLoop` runs on `prodPaths` only                 | `validation_fail:ts` from test-file noise |

**Result: 6/16 commits (~38 %)** across hono + trpc.

Commits (representative):

| Target | Task                                      | Files | Outcome                |
|--------|-------------------------------------------|-------|------------------------|
| hono   | JSDoc on `Hono.constructor`               | 1     | committed              |
| hono   | `request-id` middleware                   | 1     | committed              |
| hono   | param `count` helper                      | 1     | committed              |
| hono   | `parseQS` utility                         | 1     | committed              |
| trpc   | `onError` in standalone adapter           | 1     | committed              |
| trpc   | `getErrorCode` helper                     | 1     | committed              |

Failures clustered on multi-file tasks that exceed even the tightened context budget.

### v1.38 → v1.68c — climbing to 100 %

Each row below is the single change that moved the headline metric, not the full changelog (full log in [CHANGELOG.md](CHANGELOG.md)).

| Version | Date       | Key change                                          | Effect                                            |
|---------|------------|-----------------------------------------------------|---------------------------------------------------|
| v1.39-a | 2026-05-14 | Cumulative branch + ff-merge + `NoopStepError`     | Cumulative chain stable; noop is a distinct fail   |
| v1.39-b | 2026-05-14 | `VALIDATION_TIMEOUT_MS` guard                       | `validation_incomplete` cohort → 0                |
| v1.39-c | 2026-05-14 | Reviewer-reject dispatch to tool-calling Fixer      | `reviewer_reject` on T6 / H4 closed               |
| v1.40   | 2026-05-14 | TesterAgent post-gen TS validation + content guard  | `body is not defined` + empty `describe()` gone   |
| v1.41   | 2026-05-14 | Planner retry + noop retry + monorepo meta          | `ts_fail` (workspace imports) + `llm_parse_fail` → ~0 |
| v1.43   | 2026-05-15 | Full 12-task bench refinement (Gemma)              | hono 5/6, trpc 5/6 — **real-repo 92 % peak**       |
| v1.47   | 2026-05-15 | H4 prompt fix (validate option)                    | hono **6/6** ✅                                    |
| v1.50   | 2026-05-15 | Structural anchor v2 (overload-aware)              | hono L6 large-file (>480 LOC) **3/4**             |
| v1.51   | 2026-05-15 | Extension detection (.tsx, .mts)                   | zod cross-repo **4/4**                            |
| v1.52   | 2026-05-15 | `GET /project/:id/healthcheck`                     | Pre-flight surfaces missing build / vitest setup  |
| v1.61   | 2026-05-18 | Qwen3-35B MoE 32K as default Coder                 | Sandbox 7/7; ~11 tok/s on RTX 3090               |
| v1.63   | 2026-05-18 | `read_file start_line` + large-file nudge          | vite **6/6** ✅, including 1835-line file edit    |
| v1.64   | 2026-05-19 | Repo memory (`repo_patterns` table)                | Recurring errors visible to Planner / Coder       |
| v1.65b  | 2026-05-19 | `add_type_member` AST tool                         | T6 noop on 900-line `dataLoader.ts` → commit      |
| v1.65c  | 2026-05-19 | TestRunner timeout 60 s → 120 s                    | Large monorepo (trpc) tests stop being killed     |
| v1.65d  | 2026-05-20 | `add_type_member` intersection + ADD-OPTION rule   | trpc **5/6** with Qwen3 MoE — equals Gemma peak   |
| v1.66   | 2026-05-27 | Qdrant scope filter fix + `packageName` payload    | trpc retrieval precision ↑; hono 5/6 → 6/6 stable |
| v1.67   | 2026-05-27 | SQLite symbol table + multi-hop recursive CTE callers | 3-hop caller traversal without `code-graph` mem  |
| v1.68c  | 2026-05-29 | Fixer: block `delete_file` on test paths; SCOPE prompt fix; LLM_URL env fix | T2 requestTimeout closed — **trpc 6/6 ✅** |
| v1.69   | 2026-05-29 | Repo memory v2: `issue_hash` dedup + cross-project patterns + `hit_count` | Pattern injection now deduplicated + frequency-ranked |
| v1.70   | 2026-05-29 | Bench re-run (cross-project eval)                  | 8/12 (67%) — model variance; H6 commit bug found  |

Compounded: **6/16 (~38 %) → 12/12 (100 %)** on the combined real-repo bench. Best result: v1.68c.

---

## Where the system breaks (and why)

Fail patterns, sorted by frequency in real-repo runs:

| Pattern                | Root cause                                                                         | Mitigation                                |
|------------------------|------------------------------------------------------------------------------------|-------------------------------------------|
| Context overflow       | 32 K ctx − fixed overhead − retrieval ≈ 23 K usable; multi-file traces hit the wall | Smaller `MAX_READ_LINES`, baseline detection, deeper retrieval pruning (future) |
| Cross-file consistency | Coder updates one file, misses callsites in 7 others; graph traversal is 1-hop      | Multi-hop closure on the call graph (v1.40+) |
| Large-class surgery    | Files > 700 lines confuse structural anchor lookups (signature drift)               | Better anchor disambiguation, smaller read chunks |
| Reviewer false-rejects | Lenient prompt still catches some legitimate-but-ugly code                          | Iterate prompt; add a "style is non-blocking" rule (v1.36 did this; still tunable) |
| Cumulative state       | Task N+1 builds on N — fundamental limitation of 32 B local models, drifts after 2-3 steps | Out of scope for v1.x; needs Sonnet-class model |
| LLM scope creep        | RAG-retrieved files get rewritten alongside the intended change                     | Restricted write scope to explicitly named files (sprint D2 fix) |

---

## Model speed — RTX 3090 24 GB (2026-05-18)

Hardware: i7-10700, RTX 3090 24 GB VRAM, 80 GB DDR4 RAM, llama-swap proxy.

### Q6_K_L 32B — ngl sweep (16K ctx, q8_0 KV vs q4_0 KV)

Goal: find the fastest config for Qwen2.5-Coder-32B-Instruct-Q6_K_L within 24 GB VRAM.

| Config | ngl | KV cache | flash-attn | tok/s (gen) | Status |
|---|---|---|---|---|---|
| baseline | 54 | q8_0 | ON | **5.37** | ✅ stable |
| no-flash-attn | 54 | q8_0 | OFF | 5.36 | ✅ same speed |
| no-flash-attn | 55–64 | q8_0 | OFF | — | ❌ OOM at startup |
| q4_0 KV | 55 | q4_0 | ON | **5.84** | ✅ +7.5% |
| q4_0 KV | **56** | q4_0 | ON | **6.28** | ✅ **+15.6%** ← new best |
| q4_0 KV | 57–60 | q4_0 | ON | — | ❌ OOM at startup |

**Findings:**
- `--flash-attn` removal: no effect on OOM threshold or speed. FA2 workspace ≈ 0.3 GB — smaller than one transformer layer (~390 MB), not the bottleneck.
- `--mlock` removal: analytically no VRAM impact (only locks CPU RAM pages). Not tested separately.
- **q4_0 KV saves ~1 GB** → allows 2 more GPU layers (54→56) → +15.6% gen speed.
- Hard ceiling: ngl=56 at 16K q4_0 KV. Weight budget ~22.4 GB + KV ~1 GB + overhead ≈ 24 GB.
- CPU bottleneck for ngl=54: 10 CPU layers × ~390 MB / DDR4 ~45 GB/s ≈ 87 ms/token.

**New production config for Q6K_L:** `ngl=56, q4_0 KV, 16K ctx` — alias `ngl56-q4kv`.

### Qwen3-35B MoE (UD-Q4_K_M, 32K ctx, q4_0 KV)

| Context | tok/s (gen) | Notes |
|---|---|---|
| Short (~30 tokens) | ~117 tok/s | MoE 3B active params, trivial attention |
| Real agent runs (~25K RAG context) | **~11 tok/s** | Attention over large KV dominates |

MoE active-parameter advantage evaporates at large context due to KV cache attention cost.

---

## What works well

- **Sandbox-quality TypeScript** — when the task fits the context, the generated code is genuinely idiomatic. Generic constraints, async cleanup, hooks, middleware patterns all come out clean.
- **Validation loop catches issues early** — TypeScript pre-check before the test run cuts feedback latency from "tests fail with a wall of unrelated errors" to "Coder, fix this specific tsc error in `users.ts:42`".
- **Baseline filtering** — running the test suite on a clean repo before the first task and ignoring those failures during validation kills 22 % of false negatives on real OSS repos.
- **Indexing speed** — `nomic-embed-text-v1.5` with `EMBED_CONCURRENCY=8` indexes ~150 files / minute. The 700-file trpc monorepo indexed in ~4 minutes cold.

---

## Reproducing the runs

```bash
# 1. Start llama-swap with the model aliases (see docs/SETUP.md)
# 2. Start the API server
npm run start

# 3. Register the target repo
curl -X POST http://localhost:3000/project \
  -H "Content-Type: application/json" \
  -d '{"root": "/path/to/honojs/hono"}'

# 4. Index it
curl -X POST http://localhost:3000/index \
  -H "Content-Type: application/json" \
  -d '{"project": "<project_id>"}'

# 5. Submit a task from tasks.md
curl -X POST http://localhost:3000/task \
  -H "Content-Type: application/json" \
  -d '{"task": "Add a request-id middleware that injects x-request-id", "project": "<project_id>", "mode": "balanced"}'
```

Open a parallel `curl -N http://localhost:3000/task/<task_id>/stream` to watch SSE events in real time. The structured event stream is what the VS Code extension consumes.
