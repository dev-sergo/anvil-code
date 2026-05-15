# Benchmark

Quantitative track record of the RAG System on TypeScript codebases. Methodology is reproducible; raw run files live in [docs/benchmarks/runs/](docs/benchmarks/runs/) — one file per iteration so regressions show up in `git diff`.

## TL;DR

| Target                | Size           | Tasks | Success | Notes                          |
|-----------------------|----------------|-------|---------|--------------------------------|
| `rag-system-sandbox`  | 30 TS files    | 16    | **87.5 %** (14/16) | Curated suite L1–L5, all categories |
| `honojs/hono`         | 366 TS files   | 6     | **100 %** (6/6, v1.47) | Real OSS, mature codebase |
| `trpc/trpc`           | 907 TS files   | 6     | **67 %** (4/6, v1.43–v1.47 best) | pnpm monorepo, project refs |
| **Combined real-repo** | | **12** | **92 % (11/12)** | v1.43 peak; 83–92% across runs |

Sandbox numbers measure code-generation ceiling. Real-repo numbers measure operational ceiling. Combined **42 % → 92 %** improvement from v1.38 → v1.50. Remaining failures: model variance on complex trpc internals (T2/T5) and VRAM wall on 900-line files (T6).

Additional bench categories (v1.39+):
- **Cumulative mode** (sequential tasks accumulating in `auto/cumulative`): **6/6** on sandbox.
- **L6 large-file surgery** (overload disambiguation, property arrows): **3/4** on hono files >480 LOC.
- **Cross-repo** (new repo without training exposure): zod **4/4** after v1.51 extension detection; vite 0/6 (needs `pnpm build` pre-flight).

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
