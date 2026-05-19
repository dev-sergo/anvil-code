# Changelog — Anvil-Code

> Chronological archive of iterations. Each entry covers what changed, why, and the result, with links to design docs and bench runs.
> Format: append-only, newest first.

---

## trpc bench v1.65c — 5/6 (83%) new Qwen3 record (2026-05-19)

T1✅ T2✅ T3❌ T4✅ T5✅ T6✅. **Equals Gemma v1.43 peak.** T2 first Qwen3 commit ever (repo memory helped import path). T6 first commit via add_type_member. T3 persistent reviewer_reject (Qwen3 over-refactors standalone types). Root cause of previous failures: TestRunner 60s timeout killed tests at 61s (54s + 7s codegen).

Run file: [2026-05-19-trpc-v1.65c-full.md](docs/benchmarks/runs/2026-05-19-trpc-v1.65c-full.md)

---

## v1.65c — TestRunner timeout 60s → 120s (2026-05-19)

trpc test suite takes 54s clean + 7s openapi codegen = 61s → SIGKILL after 60s → all tasks commit_skipped. Fixed by doubling timeout. **Confirmed T5 ✅ (maxBodySize, uses opts.maxBodySize correctly) and T6 ✅ (dataLoader retry, new file with DataLoaderOptions.retry) in trpc bench.** T1-T4 expected to pass in next full run.

---

## v1.65b — add_type_member: AST-anchored interface/type member insertion (2026-05-19)

New structural tool for tool-calling Coder: `add_type_member(file, type_name, member)`. Uses TypeScript Compiler API to locate an `interface` or type-alias object literal by name, finds the closing `}` line, inserts the member with correct indent. No line-number guessing — model names the type, runtime does the navigation.

Target: T6 dataLoader retry — `add_type_member("dataLoader.ts", "DataLoaderOptions", "retry?: number")` instead of hunting for the right lines in a 900-line file. Same architectural pattern as existing `add_method`/`replace_method` tools.

5 unit tests added. Build 12/12 ✅, tests 607/610 ✅.

---

## v1.65a — Reviewer leniency for refactor steps (2026-05-19)

Added REFACTOR STEPS paragraph to Reviewer prompt: structural changes (object→class, arrow→regular fn, property→static method) are not blocking if public API is preserved. Tightened REJECT criterion from "existing code deleted" to "whole operation completely absent". **L3.1 result: 1/3** in sample run — statistically inconclusive vs. pre-fix 50-70%. Root cause confirmed: Coder sometimes generates class without `static` keyword (Reviewer correctly rejects). Real fix is AST-level class conversion (v1.65b).

---

## v1.64 — Repo memory: learned patterns from Fixer fixes (2026-05-19)

**Problem:** Model repeats the same import/API mistakes across tasks in the same repo (trpc T2: TS2307 bad import path happened 6 times). The `failures` table counted errors but didn't inject the lesson into future task context.

**Fix:** New `repo_patterns` table in `memory.db` (per-project). When validation Fixer successfully repairs TS/test issues, the raw error text is saved. On subsequent tasks, Planner + Coder + Fixer see a "Repo-specific patterns" section above Project Conventions with these learned constraints.

**Expected effect:** After first T2 failure + Fixer fix in trpc → second T2 run would see "TS2307: Cannot find module '../../unstable-core-do-not-import/...' was previously fixed" and use correct import path proactively.

**Tests:** 602/605 ✅ (3 pre-existing ASTParser only).

---

## trpc bench session — Qwen3-35B MoE (2026-05-19)

**Result:** trpc **2/6 (33%)**. T1✅ (JSDoc, 20 lines) T4✅ (createTimeout, 5 lines). T2❌ ts_fail (bad import path) T3❌ vitest crash (Qwen3 over-refactored StandaloneHandlerOptions types) T5❌ test_fail (hardcoded limit, broke existing maxBodySize option) T6❌ noop (900-line dataLoader, model decided no changes needed).

**Key finding:** trpc `packages/openapi` has a vitest globalSetup that regenerates hey-api clients whenever `server/src/**` changes. Old cache (Gemma run) caused hash mismatch → codegen broke client imports. Fix: `cd packages/openapi && pnpm codegen` before bench (7s). Added to memory and bench run notes.

**Gemma peak (v1.43) remains 5/6 on trpc.** Qwen3 thinking mode causes T3 over-refactoring; T6 noop persists (read_file start_line helps navigation, not "should I edit" decisions).

Run file: [2026-05-19-trpc-qwen3-moe.md](docs/benchmarks/runs/2026-05-19-trpc-qwen3-moe.md)

---

## v1.63 — read_file start_line offset + large-file add_export nudge (2026-05-18)

**Root cause (V3 vite bench):** utils.ts is 1835 lines; `read_file` showed only lines 1-350. The truncation message said "use replace_in_file with known line numbers" → Qwen3 guessed coords 1830-1836 and deleted `getFileStartIndex`. qwen2.5-coder had used `add_export` (correct); Qwen3 did not.

**Fix:** `read_file` now accepts optional `start_line` parameter (1-based offset). For a 1836-line file, `read_file("utils.ts", 1486)` shows lines 1486–1836. Truncation message rewritten: shows the exact `start_line` to reach the end and prominently suggests `add_export` as the zero-coord alternative. FEATURE_SPEC updated accordingly. 4 new unit tests.

**Result:** Qwen3 read lines 1-350 first, saw the truncation hint with `start_line=1800`, navigated to the end, used `add_export` → 29 lines added, 0 deleted, `getFileStartIndex` preserved, tests pass. **Vite V3 committed `386eb921`**. Vite bench: **5/5 ✅**.

---

## v1.62 — ESM production guard in Orchestrator (2026-05-18)

**Root cause (V2 vite bench):** Qwen3 generates `require()` in production ESM files (e.g. `getViteVersion.ts`). The existing ESM guard in `validateAndFilterTestFiles` only filtered test files; production code passed through untouched.

**Fix:** After the noop-retry check in `executeStep()`, `detectEsmProductionViolators()` scans all production `FileChange` entries for `require()`/`__dirname`/`__filename` patterns (both `create` content and `modify` replace-texts). In ESM projects (`"type":"module"` in `package.json`), any violation triggers one retry with an explicit nudge: lists the offending files and shows the correct `import` syntax. Cap at 1 retry — residual violations fall through to the validation loop and Fixer. `getIsEsmProject()` is cached per-task and reused in `validateAndFilterTestFiles` (de-duplicates the inline calculation). **7 new unit tests. 605/609 total (4 pre-existing unchanged).**

---

## hardware-bench — Q6K_L ngl sweep on RTX 3090 (2026-05-18)

Hardware-only experiment: find the fastest llama-swap config for Qwen2.5-Coder-32B-Instruct-Q6_K_L within 24 GB VRAM.

**Finding 1 — flash-attn is not the OOM culprit.** Removing `--flash-attn on` from `base_flags` did not allow higher ngl values. FA2 workspace (~0.3 GB) is smaller than one transformer layer (~390 MB), so it cannot explain the ngl=55 crash.

**Finding 2 — q4_0 KV saves enough to unlock 2 more GPU layers.** Switching KV cache from q8_0 to q4_0 frees ~1 GB → ngl=56 fits, ngl=57 still crashes. Results (3-run averages):
- ngl=54, q8_0 KV (baseline): **5.43 tok/s**
- ngl=55, q4_0 KV: **5.84 tok/s** (+7.5%)
- ngl=56, q4_0 KV: **6.28 tok/s** (+15.6%) ← new best

**Action:** llama-swap config on server updated — alias `ngl56-q4kv` is the new Q6K_L production profile. Full results in [BENCHMARK.md](BENCHMARK.md#model-speed--rtx-3090-24-gb-2026-05-18).

---

## v1.40 — TesterAgent post-generation TS validation (2026-05-14)

**Root cause (v1.39 bench):** TesterAgent-generated test files bypassed TypeScript checking entirely — `isTestPath` filter in the pre-Reviewer TS check excluded them. `body is not defined` (L1.1 r2) and stale-list assertion (L4.1 r1) reached validation and blocked commits on correct production changes.

**Fix:** `Orchestrator.validateAndFilterTestFiles()` — after `tester.execute()`, writes test files to disk, runs `typeChecker.runOn(testPaths)` once, parses error output by file path, discards any file whose path appears in errors and restores disk state. Files that pass remain on disk and proceed through the pipeline. Tester stays best-effort: partial success (some valid, some discarded) is fine. TesterAgent prompt extended with rules 11–12: explicit ban on undeclared variable access (`body` before assignment) and fragile exact-length list assertions without controlled state. **550/550 unit tests, 12/12 packages.**

---

## v1.61 — Qwen3-35B MoE as default Coder (2026-05-18)

`LLM_LARGE_MODEL` and `LLM_SMALL_MODEL` both switched to `qwen3-32k` (Qwen3-35B-A3B MoE, 32K ctx).

**Why:** Qwen3 MoE has only 3B active parameters per forward pass → **11 tok/s** vs ~5 tok/s for dense 32B models. Thinking mode improves planning quality. 32K context handles large RAG payloads (vite's config.ts 2728 lines, utils.ts 1835 lines).

**Bench results vs previous best (qwen2.5-coder Q6_K_L):**
- Sandbox: **3/3 ✅** (was 2/3 — S1 Reviewer rejection fixed by thinking mode)
- Vite V1 JSDoc defineConfig (config.ts 2728 lines): ✅ (was ❌ model ceiling for all dense models)
- Vite V6 createServer JSDoc (re-export chain): ✅ (was ❌ noop for Gemma)
- Vite V3 parseAcceptHeader (utils.ts modification): ❌ test fail (same hard case as before)
- Speed: **2× faster** than any dense 32B variant

**Note:** Both LARGE and SMALL on qwen3-32k — Planner needs 32K to fit large vite RAG context (25K tokens).

---

## v1.60 — Reviewer leniency + FEATURE_SPEC ESM rule (2026-05-17)

Reviewer: added two DO NOT reject items — compact handler signatures and exact error message wording. Fixes S2 (bug fix) which was rejected for error message case. S1 (health endpoint) still fails: qwen2.5-coder Reviewer ignores the rule and rejects compact Fastify handlers.

FEATURE_SPEC: added MODULE SYSTEM rule for Coder — ESM projects must use import syntax, never require(). V2 (getViteVersion) still fails: qwen2.5-coder Coder ignores the rule and generates require().

**Model tradeoff documented:** qwen2.5-coder as Coder improves complex navigation (V3, V6) but regresses simple sandbox tasks (S1) and ESM compliance (V2). Gemma was reliable on S1/S2 but couldn't navigate large files. No single model excels at both. **588/595 tests (same 3 pre-existing ASTParser).**

---

## v1.59 — ESM guard + qwen2.5-coder as Coder model (2026-05-17)

`validateAndFilterTestFiles`: ESM guard discards test files using `require()`/`__dirname` in ESM-first projects (`"type":"module"` in package.json). Prevents eslint `no-restricted-globals` commit failures. `LLM_LARGE_MODEL` switched to `qwen2-5-coder-32b-instruct-q4-k-m-ctx-32k`.

**Bench (vite V1-V6, qwen2.5-coder):** V3 ✅ (parseAcceptHeader — was Gemma ceiling), V5 ✅ (ESM guard), V6 ✅ (createServer JSDoc via re-export chain — was Gemma noop). Score: **3/6** (same count, better tasks: V3/V5/V6 vs Gemma's V1/V2/V5). V1 (config.ts 2728 lines) → qwen2.5-coder also noops. **595/595 tests.**

---

## v1.58 — Pre-commit hook retry + TesterAgent ESM-only rule (2026-05-17)

`commitChanges` now detects when a pre-commit hook reformats staged files (formatter hooks: prettier, oxfmt, etc.) by checking for modified tracked files after a commit failure, then re-stages and retries once. Handles the common lint-staged pattern where the formatter modifies files but leaves them unstaged.

TesterAgent rule 15: never use `require()` — ESM import syntax only. Fixes generated test files using CommonJS `require()` in ESM-first projects (caught by eslint in vite's pre-commit hook: `no-restricted-globals`). +4 unit tests for hook retry scenarios. **595/595 tests.**

---

## v1.57 — Reviewer isolation: anchor prompt + grounding rule (2026-05-16)

Two changes to prevent semantic bleed when tasks from different projects run sequentially in the same queue. Reviewer prompt now includes a CRITICAL grounding rule: "evaluate ONLY the files and step provided, ignore prior context." User prompt prefixed with `[Reviewing changes in: path1, path2, ...]` as an explicit file-path anchor before the step description.

**Validation:** V1 (JSDoc on vite defineConfig) now commits after 3 sandbox tasks (was rejected with "User type" hallucination before fix). **591/591 tests.**

**Side finding:** vite's pre-commit hook (lint-staged + oxfmt) rewrites new TypeScript files on commit, leaving unstaged diff → commit fails. Affects V2 (getViteVersion.ts). Separate bug, not Reviewer-related.

---

## v1.56 — add_export duplicate guard + done() pre-flight check (2026-05-16)

`locateAddExport` now checks if a top-level symbol with the same name already exists before inserting. `done()` handler scans all modified files for duplicate top-level exports before finalising — catches cases where Coder uses both `add_export` and `replace_in_file` on the same symbol in one step. `WorkingSet.modifiedEntries()` added to support the scan.

**Context:** V3 (parseAcceptHeader in vite's utils.ts, 1835 lines) — Gemma-26B produces duplicate definitions on large files. Guards prevent the corrupted output from reaching Reviewer; Coder gets explicit feedback to correct. V3 remains model-ceiling (Gemma unreliable on 1835-line files). Guards are valuable for smaller files. **591/591 tests.**

---

## v1.55 — Structural anchor v3: embed current content in property arrow error (2026-05-16)

`locateReplaceMethod` now embeds the current source lines of the property arrow directly in
the error message. Previously: "call read_file first, then use replace_in_file" — required an
extra LLM round-trip and sometimes led to noop. Now: error includes `Current content (lines X–Y):`
so Coder can immediately write the `replace_in_file` call without reading the file separately.

**L6 spot-check:** L6.2 (query JSDoc, request.ts 489 lines) ✅ confirmed no regression.
L6.4 (redirect() property arrow, context.ts 780 lines) ❌ unchanged — model noop before even
reaching replace_method. Root cause: file too large for Gemma's effective engagement at current
context budget. Fix helps medium-complexity property arrows (<500-line files); 780-line ceiling
requires 32K aux model. L6 baseline remains **3/4 (75%)**. **589/589 tests.**

---

## v1.54 — Dirty working tree fix + TesterAgent async rules (2026-05-16)

**A) GitEngine:** `createBranchForTask` now runs `git checkout -f <base>` + `git clean -fd` before
forking. `commit_skipped` tasks left modified tracked files and untracked spec files in the working
tree; subsequent tasks started from dirty state, corrupting baseline fingerprints.

**B) TesterAgent:** Rules 13-14 added: lifecycle hooks using `await` must declare `async`; modules
under test must use static top-level imports, not dynamic `import()` inside `beforeEach`.

**Bench result (vite cross-repo v3):** 2/6 ✅ — V2 (getViteVersion new file) + V5 (HMR_HEADER_NAME).
Up from 0/6 baseline. V1/V3 blocked by 16–25K token context ceiling (needs 32K aux model).
V4 Reviewer correctly caught wrong import (progress vs prior noop). V6 noop unchanged. **589/589 tests.**

---

## v1.53 — TestRunner unit-script preference (2026-05-16)

**Root cause (vite cross-repo bench):** `npm test` in vite = `test-unit && test-serve && test-build`. E2e tests (test-serve/test-build) require a browser/server and always fail/timeout in our environment. Baseline detection captured no fingerprints → every post-change test failure treated as new → `commit_skipped` even when code was correct (V5: `HMR_HEADER_NAME = 'x-vite-hmr'` was correct but blocked).

**Fix:** `TestRunner.run()` now checks for `test-unit` / `test:unit` scripts. If one exists AND the main `test` script chains via `&&`, runs the unit-only variant instead. Vite baseline now runs in ~4s, passes 802/806 tests. V5 constant task now commits in ~90s.

**Side findings from vite bench:** TesterAgent generates invalid async patterns (`await` in sync `beforeEach`) for complex fs-mocking scenarios → V2 blocked. Large files (V3/V4/V6) still hit 16K context ceiling — needs 32K aux model. **589/589 unit tests.**

---

## v1.52 — Pre-flight healthcheck endpoint (2026-05-15)

`GET /project/:id/healthcheck` — runs `tsc --noEmit` + `npm test` on clean project state, returns `{ready, tscOk, testsOk, issues[]}`. Results cached per project, invalidated on re-index. Surfaces infrastructure failures upfront so operators know before wasting bench runs:

- **sandbox** → `{ready: true, tscOk: true, testsOk: true, issues: []}`
- **vite** → `{ready: false, issues: ["Test runner startup failed — missing build artifacts"]}`
- **zod** → `{ready: false, issues: ["TypeScript errors on clean baseline", "Tests fail on clean baseline"]}`

Optional `?force=true` to bypass cache. 589/589 tests.

---

## v1.51 zod re-bench — 4/4 (100%) (2026-05-15)

Re-ran Z1, Z3, Z4 on v1.51 (Z2 already verified on initial commit). All 4 ✅:
- Z1 ✅ `68712fe4` — JSDoc on `flattenError` (3 overloads, 455-line file) — structural anchor v2 found implementation overload, JSDoc placed correctly
- Z3 ✅ `9a2bb138` — `summarizeErrors` helper added to errors.ts
- Z4 ✅ `2a2f7259` — `ZOD_LOCALE_VERSION = "4.0"` const in en.ts

Cross-repo zod went from 0/4 (v1.50) → **4/4 (100%)** with v1.51 extension auto-detection. Combined with v1.50 anchor v2 (overload disambiguation works on Z1's flattenError), the system now transfers cleanly to a new TypeScript repo with strict gitignore + extensive test suite.

**Cross-repo summary update:**
| Repo | v1.50 | v1.51 |
|------|-------|-------|
| hono | 6/6 | 6/6 |
| trpc | 5/6 | 5/6 |
| vite | 0/6 | (would benefit from infra fixes) |
| zod | 0/4 | **4/4** |

---

## v1.51 — TesterAgent test extension auto-detection (2026-05-15)

`ProjectConventions.testFileExtension` — new field. `detectTestFileExtension(root)` scans `src/`, `packages/`, `tests/`, `test/`, `__tests__/` (depth ≤4, skips `node_modules`, `dist`, `build`, `coverage`, dot-dirs) for files matching `.test.ts`, `.test.tsx`, `.test.js`, `.test.mjs`, `.spec.ts`, `.spec.js` and returns the most frequent. Falls back to `.test.ts` for empty TypeScript projects. `Orchestrator.validateAndFilterTestFiles` rewrites generated test paths to match the detected extension before disk write — closes the cross-repo `.test.js` vs `.test.ts` mismatch that blocked vite + zod (zod gitignores `.test.js`). **Verification:** zod Z2 (getZodVersion helper) — was `validation_pass` + git fail in cross-repo bench; now ✅ commit `f1155c63` (TesterAgent generated `version.test.ts` with correct extension, dropped at dry-run, production `version.ts` committed). +5 unit tests. **589/589.**

---

## Cross-repo bench: zod (2026-05-15)

zod (colinhacks/zod, 402 TS files, 1761 vectors, clean test setup unlike vite). 4 tasks tried: 0/4 commits, but Z2 produced correct code (`version.ts` added, validation_pass) — blocked at commit by TesterAgent generating `.test.js` (zod gitignores `.test.js`, accepts only `.test.ts`). Earlier round with hallucinated function names (`issuesToZodError`, `formatZodError`) → both noop. Coder correctly returns no changes for non-existent targets. Z1/Z3/Z4 (real targets) → test_fail (zod's 3811-test suite is sensitive to additions; TesterAgent tests likely fail). Combined cross-repo finding: code generation works, validation pipeline assumes simpler test/git setup than mature OSS projects have. Bench: [2026-05-15-cross-repo-zod.md](docs/benchmarks/runs/2026-05-15-cross-repo-zod.md).

---

## Cross-repo bench: vite (2026-05-15)

First non-hono/trpc bench — vite (vitejs/vite, 1413 files, 1598 vectors). 0/6 tasks committed, but failures are infrastructure (vite needs `pnpm install && pnpm build` before tests run; vitest crashes at startup), context (utils.ts 1835 lines exceeds qwen3 16K context for Reviewer/Tester), and one model variance (V1 llm_parse_fail). V5 production code was correct (`HMR_HEADER_NAME` added to constants.ts) but vitest crash blocked commit. Honest finding: cross-repo transferability requires pre-flight check that test pipeline runs cleanly on baseline. Bench: [2026-05-15-cross-repo-vite.md](docs/benchmarks/runs/2026-05-15-cross-repo-vite.md).

---

## v1.50 — Structural anchor v2: overload disambiguation + property arrow (2026-05-15)

`findMethod` v2: (1) multiple MethodDeclaration overloads → prefer implementation (method with body) over signature-only overloads; use `nearLine` hint to pick among multiple bodies; (2) property arrow function (`name = (...) => {}`) fallback — detected and reported with exact `startLine–endLine` range and prescriptive `replace_in_file` call in the error. `replace_method` tool: optional `nearLine` parameter. FEATURE_SPEC: explicit 3-step workflow for property arrow functions. **L6 bench** (large-file surgery): L6.1 ✅ HonoRequest.header() implementation overload (489 lines, 3 overloads, 290s); L6.2 ✅ query() JSDoc (62s); L6.3 ✅ getter in Hono class (539 lines, 114s); L6.4 ❌ redirect() property arrow with complex generics (780 lines, model limit). **3/4 (75%)** on new large-file task class. +3 unit tests (overload → impl, nearLine, arrow error). 584/584.

---

## v1.49 — Task cancellation (2026-05-15)

`POST /task/:id/cancel` — operators can now stop a queued or running task. `MemoryQueue.cancel(id)` sets status to `'cancelled'`; `isCancelled(id)` lets callers poll. `JobWorker` checks cancellation before starting execution and creates a `shouldCancel: () => boolean` callback passed to `Orchestrator.runTask`. `executePlanParallel` checks `shouldCancel()` before launching each step — running steps complete naturally (no mid-LLM-call interruption), pending steps are skipped. `TaskEventType` extended with `'cancelled'`. +2 unit tests (cancelled mid-run partial result, no-cancel normal run). 578 passing.

---

## v1.48 Qdrant payload filter bench (2026-05-15)

Re-indexed trpc (907 files → 2292 Qdrant vectors, 13s). Ran T2+T5 with `VECTOR_BACKEND=qdrant`. T2 `extractPackageScope("packages/server/src/http/...")` = `packages/server` → Qdrant search filtered to `packages/server/` files. **Pattern shift:** T2 was `ts_fail` (TS2307 bad import) with HNSW → `reviewer_reject` with Qdrant (Coder now finds correct files, but implementation names/imports still model-variance). T5 submission failed (JSON escape issue). Conclusion: payload filter improves retrieval precision (Coder reaches correct package), but implementation quality on complex trpc tasks remains at Gemma 26B capability boundary. Not a retrieval problem — a model problem.

---

## v1.47 bench — 10/12 (83%), no Qdrant regression (2026-05-15)

Full 12-task bench with HNSW backend (Qdrant separately smoke-tested ✅). Hono 6/6 (100%). tRPC 3/6: T2 ts_fail (wrong import path, model variance), T5 reviewer_reject (impl error, model variance), T6 noop (VRAM wall). Delta vs v1.43: -1 (10/12 vs 11/12) — pure model variance, no infrastructure regression from Qdrant addition. Bench: [2026-05-15-v1.47-full-12task.md](docs/benchmarks/runs/2026-05-15-v1.47-full-12task.md).

---

## v1.46 bench + tuning (2026-05-15)

Full 12-task bench revealed regression at `RAG_GRAPH_HOPS=3`: 11/12 → 9/12 (hono stable 6/6, trpc 5/6→2/6). Root cause: 3-hop BFS in trpc (3938 symbols) floods token budget with unrelated cross-package callers before relevant context. Default reverted to `RAG_GRAPH_HOPS=1` (= v1.43 1-hop direct callers, validated at 11/12). `RAG_CALLERS_PER_SYMBOL=3` cap added. Infrastructure remains for explicit cross-service refactoring tasks (set `RAG_GRAPH_HOPS=2-3` manually). L2.3 soft-delete ✅ at hops=1 (types+service+routes, 206s). Bench: [2026-05-15-v1.46-full-12task.md](docs/benchmarks/runs/2026-05-15-v1.46-full-12task.md).

---

## v1.46 — N-hop transitive caller BFS (2026-05-15)

`CodeGraph.getTransitiveCallers(seeds, maxHops, seen)`: BFS over the reverse index (built in v1.43), expanding frontier level by level up to `maxHops`. Each hop is O(callsites) — the reverse index is pre-computed. `GraphRetriever.retrieveContextItems`: replaces 1-hop `getCallers` loop (v1.43) with `getTransitiveCallers(primarySymbolNames, config.rag.graphHops, seen)`. Default `RAG_GRAPH_HOPS=3`. **Bench:** L2.3 soft-delete (3-file cross-service: types.ts + user-service.ts + routes.ts) ✅ commit in 206s — transitive callers surfaced all 3 files including UserService.list() callers. +4 unit tests. **569/569, 12/12 packages.**

---

## v1.45 — FEATURE_SPEC multi-file task guidance (2026-05-15)

Workflow step 5: "if the step names multiple files, read_file and edit EVERY one before done()". SCOPE DISCIPLINE: "scan Allowed write targets before done() — if multiple .ts/.tsx files listed, verify all edited. Type definition file + implementation file often both need changes — skipping the type file is the #1 silent failure mode." **C5 TTL session cumulative bench: ✅ 3 files (types.ts + user-service.ts + routes.ts)** on clean sandbox. Full C1-C5 cumulative run: **5/5 ✅** — first clean sweep. (Previous C5 failures were due to sandbox contamination from prior runs AND ambiguous task description.) 565/565 unit tests.

---

## v1.44 — TesterAgent runtime dry-run (2026-05-15)

`TestRunner.runOn(paths)`: runs `npx vitest run -- path1 path2` on specific files. `validateAndFilterTestFiles`: after TS check passes, runs `testRunner.runOn(written)` — discards test files that fail at runtime. Catches wrong API format assertions (array vs `{users,total}` after pagination change) and timing-sensitive tests (rate limit counters) that TS check cannot detect. **C6 rate limiting ✅ in both cumulative bench runs** (was ❌ in v1.43 — timing-sensitive server.test.ts discarded, Coder's implementation commits cleanly). Bench: [2026-05-15-v1.44-cumulative-dryrun.md](docs/benchmarks/runs/2026-05-15-v1.44-cumulative-dryrun.md). 565/565 unit tests.

---

## v1.43 cumulative mode bench (2026-05-15)

6 sequential tasks on sandbox with `CUMULATIVE_MODE=true`. Result: **5/6 commits**, each task forks from `auto/cumulative` (accumulated state). `cumulative_merged` fires after every successful commit; ff-merge happens automatically with no manual work. v1.37 had same 5/6 score but required manual merge between tasks and had a race condition — both now eliminated. C4 (pagination) and C6 (rate limiting) fail on TesterAgent test quality, not cumulative logic. Bench: [2026-05-15-v1.39a-cumulative-mode.md](docs/benchmarks/runs/2026-05-15-v1.39a-cumulative-mode.md).

---

## v1.43 bench — 11/12 (92%) with precise task descriptions (2026-05-15)

T5 (maxBodySize) re-run with explicit JSON format spec: `HTTP 413 + { error: 'Payload Too Large' } + Content-Type: application/json`. Result: ✅ commit 161s (was `reviewer_reject` — Reviewer correctly blocked ambiguous spec). **Full bench with correct task descriptions: 11/12 (92%)** vs 5/12 (42%) in v1.38. Only T6 remains (dataLoader.ts 900+ lines complex generics — 24GB VRAM wall, not addressable at current model size).

---

## v1.43 — 2-hop retrieval: reverse dependency index (2026-05-15)

`CodeGraph.reverseIndex`: built incrementally on `addFile`/`removeFile`, rebuilt on `loadFromDisk`. `CodeGraph.getCallers(name)` returns symbols that reference `name` in their body — enables "who uses this symbol" queries. `GraphRetriever.retrieveContextItems`: after primary top-k + 1-hop deps, appends caller symbols (up to 3 per primary, within token budget). Surfaces usage context alongside definitions. **H6 bench task fix:** added "Do not import from client/ directories" constraint → H6 ✅ (was reviewer_reject on wrong import). **T6 remains noop** — dataLoader.ts 900+ lines with complex generics exceeds Gemma 26B capability on this task class (24GB VRAM cap). +5 unit tests (reverse index build/update/remove). **565/565 unit tests, 12/12 packages.**

---

## v1.42 full bench — 9/12 (75%) vs 5/12 (42%) (2026-05-14)

Full 12-task bench (same tasks as v1.38 baseline). **+33pp** across both repos: Hono 3/6→**5/6 (83%)**, tRPC 2/6→**4/6 (67%)**. New wins: H2 (llm_parse_fail→✅), H4 (reviewer_reject→✅), H5 (no_op→✅), T2 (ts_fail→✅), T3 (validation_incomplete→✅). Remaining 3 failures: H6 reviewer_reject (correct — wrong import), T5 reviewer_reject (correct — wrong format), T6 noop (900+ line file). Bench: [2026-05-14-v1.42-full-12task.md](docs/benchmarks/runs/2026-05-14-v1.42-full-12task.md).

---

## v1.42 — Monorepo meta injection in RAG (2026-05-14)

`GraphRetriever.indexMonorepoMeta()`: at the end of `indexCodebase`, parses `tsconfig.json compilerOptions.paths` and `packages/*/package.json exports`. Persists to `graphsDir/monorepo-meta.json`; loaded at API startup. `retrieveContextItems()` appends the meta as a pinned `__monorepo_imports__` ContextItem (within token budget, placed last). Early return relaxed: skips only when BOTH vector index is empty AND no meta available.

**Effect on bench (trpc):** T2 (`ts_fail` TS2307 bad import) → `test_fail` ✅ import issue closed. T5 (`ts_fail` TS2305 no exported member) → `test_fail` ✅ import issue closed. LLM now sees `@trpc/server → packages/server/src` and generates correct workspace package aliases instead of broken relative paths. `ts_fail` pattern eliminated from T2+T5 cohort. +5 unit tests (parse paths, parse exports, persist+reload, meta as ContextItem, empty project). **560/560 unit tests, 12/12 packages.**

---

## v1.41.1 — H5 bench task fix + Reviewer issues diagnostic (2026-05-14)

**Reviewer issues in step_fail:** `lastReviewIssues` captured in Reviewer loop and included in the `Reviewer rejected after N attempts` error message (up to 3 issues, 300 chars). Surfaces in bench stream without needing log access. Revealed H5 root cause immediately.

**H5 getHeader bench task reformulation:** Original task referenced `packages/hono/src/utils/index.ts` (non-existent). Real hono layout: `src/utils/headers.ts` already exists. Fixed task: add `getHeader(c: Context, name: string)` directly to `src/utils/headers.ts`, delegate to `c.req.header(name)`, type-import Context. Result: **2/2 ✅** (71s, 64s). Pattern history: v1.38 `no_op` → v1.41 `reviewer_reject` (noop retry helped) → v1.41.1 ✅ (task fix). Bench: [2026-05-14-h5-getHeader-bench.md](docs/benchmarks/runs/2026-05-14-h5-getHeader-bench.md).

---

## v1.41 — Parse-fail retry + NoopStep retry (2026-05-14)

**v1.41-a — Planner + Architect parse-fail retry:** Both `PlannerAgent.execute()` and `ArchitectAgent.execute()` now retry once on `LLM output parsing failed` — Gemma occasionally truncates JSON or prepends a preamble, killing the whole step/task. Retry fires only for parse errors (other exceptions propagate). Architect falls back to empty design if both attempts fail. Effect: L4.1 0/3 → 2/3.

**v1.41-b — NoopStep retry with CodeGraph hint:** When Coder returns 0 file changes, the orchestrator retries once with a targeted nudge. If the CodeGraph contains a symbol matching the step description, the nudge says "Symbol X already exists in Y:N — modify it, don't skip". Otherwise generic "re-read and edit" nudge. Only throws `NoopStepError` if retry is also empty. Effect: H5 hono getHeader `no_op` → `reviewer_reject` (Coder now produces files; Reviewer is new bottleneck). T6 trpc dataLoader: ✅ stable commit. **555/555 unit tests.** Bench: [2026-05-14-v1.41-parse-retry-noop-retry.md](docs/benchmarks/runs/2026-05-14-v1.41-parse-retry-noop-retry.md).

---

## v1.40 — TesterAgent validation (2026-05-14)

**v1.40-a:** `Orchestrator.validateAndFilterTestFiles()` — after `tester.execute()`, applies generated test files to disk and runs `typeChecker.runOn(testPaths)`. Files whose path appears in tsc error output are discarded and disk state restored. Closes `body is not defined` class of failures (L1.1 r2 in v1.39 bench): L1.1 goes 2/3 → **3/3**.

**v1.40-b (content guard):** Pre-disk regex check discards files with no `it()/test()` call — empty `describe` blocks are TypeScript-valid but cause vitest "No test found in suite" at runtime (L4.1 r1 in v1.40 bench). Check happens before tsc write. TesterAgent prompt rules 11–12 added: declare variables before use; avoid fragile list-length assertions without controlled state. Bench: [2026-05-14-v1.40-tester-validation.md](docs/benchmarks/runs/2026-05-14-v1.40-tester-validation.md). **551/551 unit tests.**

---

## v1.39 — Cumulative mode, validation abort guard, Reviewer-reject Fixer (2026-05-14)

**v1.39-a — Cumulative merge-wait + noop detection:** `CUMULATIVE_MODE=true` (env, default off) makes each successful task ff-merge its `auto/task-*` branch into `auto/cumulative` (configurable via `CUMULATIVE_BRANCH`). Next task forks from accumulated state instead of racing against `defaultBranch`. On non-ff conflict: `cumulative_merge_failed` event fired, branch retained for manual review, task still completes as `done`. `NoopStepError` added to distinguish "Coder 0 files" from generic step failures; `done.data.noopStepIds[]` exposed for bench analytics. `TaskEventType` extended with `cumulative_merged`, `cumulative_merge_failed`. +9 unit tests (5 git-engine, 4 orchestrator).

**v1.39-b — Validation abort guard + BUGFIX `_clear` antipattern:** `runValidationLoop` now wraps each `Promise.all([tsc, tests])` in `Promise.race` with a `VALIDATION_TIMEOUT_MS` timeout (default 300s) and a top-level try/catch — guarantees a terminal `validation_fail(reason='timeout_or_crash')` always follows `validation_start`. Closes T3 `validation_incomplete` from v1.38 real-repo bench (tsc child process hung ~305s, `done` fired with no validation result). `BUGFIX_SPEC COMMON TS PATTERNS` extended with `_clear()/_reset()/__resetForTests()` antipattern: test isolation via public API (`for (const u of store.list()) store.delete(u.id)`) instead of private reset methods. +2 unit tests.

**v1.39-c — Reviewer-reject Fixer dispatch:** Root cause of L2.x `reviewer_reject` from v1.38 bench (H4, T6): step-level Reviewer-reject path was calling patch-based `this.fixer.execute()` even with `TOOL_CALLING_CODER=true` (default since v1.32-d). Patch-based Fixer only sees `currentChanges` as `{edits:[{search,replace}]}` — no full-file content. Fix: dispatch by flag → `BUGFIX_SPEC` (tool-calling Fixer, can `read_file` → structural edits) when on; patch-based fallback preserved when off. Unifies all three Fixer call sites (pre-Reviewer TS check, Reviewer-reject, validation loop) onto BUGFIX_SPEC. Design: [v1.39-c-reviewer-feedback-loop.md](docs/designs/v1.39-c-reviewer-feedback-loop.md). +2 unit tests.

**Bench:** Sandbox 4/6 (L1.1 2/3, L4.1 2/3 — both fails = TesterAgent codegen bugs, not v1.39 regression). Real-repo `reviewer_reject` cohort: H4 r2 ✅ commit (was `reviewer_reject ×3` in v1.38), T6 r2 ✅ commit clean (was `reviewer_reject ×3` in v1.38) — **both closed on 2nd attempt**. Unit tests: **547/547**, 12/12 packages. Bench: [2026-05-14-v1.39-sandbox-real-repo.md](docs/benchmarks/runs/2026-05-14-v1.39-sandbox-real-repo.md).

---

## v1.38 — Real-repo sprint + public release (2026-05-13)

**Real-repo diagnostic & fixes (sprint D1–D2, commit `67562de`):** Ran 18 tasks against `honojs/hono` (326 files) and `trpc/trpc` (714 files) — **0/18 commits** on Day 1. Six fixes on Day 2: (1) `Promise.race([])` hang in `executePlanParallel` when all steps were synchronously skipped; (2) **baseline detection** — tsc+test failures on a clean repo are recorded once and filtered from validation (hono snapshot failures stop blocking); (3) `MAX_READ_LINES=350`, `HISTORY_KEEP_TAIL=4`, repo-map budget 5 KB, prompt-context 10 KB — cut context overflow from 33% to ~10%; (4) RAG-retrieved paths are now read-only for the Coder — eliminates destructive side-effect edits; (5) `applyAndCheckTs` excludes test files from the pre-Reviewer TS check; (6) `runValidationLoop` uses `runOn(prodPaths)` instead of full tsc. **Result: 6/16 (38%) on real repos.** Bench: [2026-05-12-real-repo-diagnostic.md](docs/benchmarks/runs/2026-05-12-real-repo-diagnostic.md).

**VSCode extension finalize:** `commit` event now includes `commitHash`. Added: (a) **RAG System: Submit Task** command with inline project picker when no active project is set; (b) second StatusBar item tracking task phase (queued / running / planning / step / validate / committed), hides after stream ends; (c) terminal toast on `done`/`error` showing `committed N files @ <hash>`, `commit skipped`, or `partial`; (d) `formatEventLine` renders `commit`/`commit_skipped`/`commit_partial` with file counts and hash; (e) `rag.showOutput` command for clicking the status bar.

**Cleanup & `.env.example` sync:** Added 7 missing env vars (`PROJECT_REGISTRY_PATH`, `PROJECTS_AUTO_REGISTER_DEFAULT`, `VECTORS_PATH`, `GRAPHS_PATH`, `BACKUPS_PATH`, `BACKUP_MAX_AGE_DAYS`, `BACKUP_PRUNE_INTERVAL_HOURS`). `LLM_LARGE_MODEL=gemma` set as validated default. `RAG_MAX_CONTEXT_TOKENS=1500` documented with context-budget trade-off note. 12/12 packages build, 534/534 tests pass.

**Public release docs:** Rewrote `README.md` (honest expectations, real numbers, benchmark tables with 🟢🟡🔴). Created `BENCHMARK.md`, `docs/SETUP.md`, `docs/ARCHITECTURE.md`. Branding: SVG logo, 820×200 README banner, 1280×640 social preview, extension icon.

---

## v1.37 — TesterAgent fixes + comprehensive bench (2026-05-11)

**TesterAgent fixes (3 patches):** (1) Rule 9 — each `testFiles` entry must contain at least one `it()`; empty `describe` triggers "No test found" in vitest. (2) Fastify test pattern — `FastifyInstance` instead of `ReturnType<typeof Fastify>` (avoids TS1361). (3) TestRunner: filter "No test found in suite" — artefact of TesterAgent, not a real test failure; no longer blocks commit.

**Result:** `TESTER_ENABLED=true` is fully functional — DELETE endpoint received 239 lines of correct vitest tests (28/28 pass, `app.inject()` integration style).

**L5.x comprehensive benchmark:** 14/16 (87.5%) — sandbox 9/10, target 5/6. Ceiling: 1–4 files ~90%, 5+ architectural ~30–50%. Design: [v1.37-l5x-comprehensive-bench.md](docs/designs/v1.37-l5x-comprehensive-bench.md). Bench: [2026-05-11-v1.37-l5x-comprehensive.md](docs/benchmarks/runs/2026-05-11-v1.37-l5x-comprehensive.md).

**Cumulative mode test:** 5/6 ✅ — pipeline accumulates changes, merge conflicts resolved, Reviewer correctly blocks bad code on complex accumulated state. Race condition on rapid task submission requires explicit merge-wait.

---

## v1.36 — Lenient Reviewer + regression suite (2026-05-11)

**Reviewer prompt rewrite:** Reoriented from "correctness, security, quality" to a strict BLOCKING / NON-BLOCKING split. BLOCKING: wrong implementation, runtime bug, existing code broken. NON-BLOCKING: style, architecture, type annotations, edge cases. Result: L3.4 Zod validation (4 files) moved from "Reviewer 3× reject" to committed. L3.3 (repository pattern) now correctly fails at validation/tests, not at Reviewer.

**Gemma 4 26B regression (L1.x + L4.x):** L1.1 /health ✅, L1.2 Zod validation ✅, L1.3 /stats + accountAge ✅. L4.1 bug fix ✅ (createdAt byte-perfect). **4/4 — no regressions**.

---

## v1.35 — Pre-Reviewer TS check + Gemma 4 Coder (2026-05-11) — L2.x: 0/8 → 7/8

**Pipeline:** `TypeChecker.runOn(paths[])` added to `safe-exec` — runs full `tsc --noEmit`, filters output to changed files only. Called inside `executeStep` after Coder, before Reviewer (up to 2 Fixer attempts). Catches parse/type errors before the LLM judge (G1). Fail-fast on `codeChanges.files.length === 0` — emits `step_noop` SSE event (G2). `executePlanParallel` accumulates `stepFailures: Map<string,string>` — "All N steps failed" now includes per-step reason (G3). `FEATURE_SPEC.pruneHistory: false→true` — eliminates context overflow at 36k tokens. +4 mock-based unit tests. **530/530.**

**Model switch:** `LLM_LARGE_MODEL=gemma` (gemma-4-26b-a4b-it-mxfp4-moe ctx-32k). Gemma 4 generates correct TypeScript with proper Fastify patterns (module augmentation, query typing) where qwen-coder-32b consistently produced type errors on the same tasks.

**Bench:** baseline qwen-coder-long 0/8 → qwen-coder-32k 2/8 → Gemma **7/8** ✅ (AC4 closed). False-positives 2→0; no-ops 2→0. Design: [v1.35-coder-reviewer-fix.md](docs/designs/v1.35-coder-reviewer-fix.md). Bench: [2026-05-11-v1.35-gemma-l2x.md](docs/benchmarks/runs/2026-05-11-v1.35-gemma-l2x.md).

---

## v1.34.1 — BUGFIX_SPEC fix + GitHub docs + .vsix (2026-05-08)

`BUGFIX_SPEC WORKFLOW` step 2 expanded to a 4-step algorithm for test failures: (a) read the test → (b) follow imports → (c) find the object literal → (d) add the **value** (`field: value`), not a type annotation. New pattern in `COMMON TS PATTERNS`: `as SomeType` does not add data — only `field: value` in the literal does. Addresses L4.1 r1 regression. **Bench v1.34.1: L4.1 ×3 = 3/3 ✅** (r1: 285s, r2: 60s, r3: 110s — all byte-perfect).

English README, `LICENSE` (MIT), `CONTRIBUTING.md` added. Extension package.json: `repository` + `license` fields. `.vsix` 29 KB, 0 warnings, smoke-tested.

---

## v1.34 — Hybrid search: BM25 + dense RRF (2026-05-08)

Pure-TS `BM25Index` (k1=1.5, b=0.75) over symbol bodies + path components. RRF merge (`k=60`) dense + BM25 in `GraphRetriever.retrieveContextItems()`. Kill-switch `RAG_BM25_ENABLED` (default true), `RAG_BM25_CANDIDATES` (default 30). `indexCodebase` excludes `data/backups/**`. `chat_template_kwargs: {enable_thinking: false}` in all LlamaSwapClient request bodies (Qwen3 fix). `interceptToolCall` hook in BUGFIX_SPEC — hard veto `create_file` on test paths. `git-engine` uses `config.git.defaultBranch` instead of hardcoded `'main'`. **+21 tests, 530/530.**

**Bench v1.34:** L1.1 ×3 = **3/3** ✅ (avg 77s). L4.1 ×3 = **2/3** (interceptToolCall fired — Fixer never created a test file). Design: [v1.34-hybrid-search.md](docs/designs/v1.34-hybrid-search.md). Bench: [2026-05-08-v1.34-hybrid-search.md](docs/benchmarks/runs/2026-05-08-v1.34-hybrid-search.md).

---

## v1.33 — BGE-reranker two-pass retrieval (2026-05-07)

HNSW(k=30) → BGE-reranker-v2-m3 → top-5 in `GraphRetriever.retrieveContextItems()`. Kill-switch `RAG_RERANKER_ENABLED` (default false). Graceful fallback on reranker error. `LlamaSwapClient.rerank()` → POST /v1/rerank, sort DESC by relevance_score. **+8 tests, 507/507.**

**Bench v1.33:** L1.2 ×3 = 2/3, L1.3 ×3 = 3/3 (first baseline). L2.1/L2.2 precision@5 = 0/3 baseline = 0/3 reranker (vocabulary gap → BM25 needed). Design: [v1.33-reranker.md](docs/designs/v1.33-reranker.md). Bench: [2026-05-07-v1.33-reranker.md](docs/benchmarks/runs/2026-05-07-v1.33-reranker.md).

---

## v1.32-c.1 — No-progress nudge before done() (2026-05-05)

Intercepts premature `done()` in `runTaskAgent`: when `successfulEdits === 0` (loop saw only errors + read_file), one `NO_PROGRESS_NUDGE` message blocks exit and suggests `replace_in_file` fallback. Second `done()` call always passes (cap=1). Also: `max_tokens: 4096` added to all LlamaSwapClient request bodies (defensive fix for thinking-mode models). **+6 tests, 499/499.**

**Re-bench:** L1.1 ×3 = **3/3** ✅ (was 2/3). L4.1 ×3 = **3/3** ✅ (was 60%). Design: [v1.32-c.1-no-progress-nudge.md](docs/designs/v1.32-c.1-no-progress-nudge.md).

---

## v1.32-d — llama-swap backend (2026-05-02)

Replaced `OllamaClient` with `LlamaSwapClient` (OpenAI-compatible API). Default flipped to `LLM_BACKEND=llamacpp`. Ollama retained as fallback. L1.1 ×4 (3/3, mean 101s, ~50% faster than Ollama). **+34 tests, 445/445.** `mergeFixerChanges` fix (Coder edits preserved when Fixer touches a subset). nomic-embed-text-v1.5 task-prefixes (`search_query:` / `search_document:`) wired backend-agnostic. Design: [v1.32-d-llamacpp-backend.md](docs/designs/v1.32-d-llamacpp-backend.md).

---

## v1.32-c — Task-agents over shared loop (2026-05-02)

Unified `runTaskAgent(spec, input)` loop in `packages/agents/src/task-agents/` with three specs: `FEATURE_SPEC`, `BUGFIX_SPEC`, `REFACTOR_SPEC`. Specialization through prompts + tool selection, not separate classes. **Bench (retro 2026-05-04):** L1.1 ×3 = 2/3, L3.1 ×3 = 3/3 byte-perfect, L4.1 ×5 = 3/5. Design: [v1.32-c-sub-agents.md](docs/designs/v1.32-c-sub-agents.md).

---

## v1.32-a — Fixer reliability series (2026-04-30)

Four sub-iterations tightening Fixer correctness and safety:

- **v1.32-a** — `buildFixerAllowedSet` discards test paths from issue-mention pool. Test-gaming eliminated.
- **v1.32-a.1** — `read_file(p)` grants write permission to `p` in the current loop. First L4.1 byte-perfect fix in working tree.
- **v1.32-a.2** — `runValidationLoop` returns `writtenFiles` — Fixer writes aggregated into the commit file list.
- **v1.32-a.3** — Consolidated `FIXER_SYSTEM_PROMPT`. Progressive nudges on no-tool-calls, bail on 3rd consecutive text-only response. **First end-to-end committed bug-fix.**
- **v1.32-a.4** — L4.1 ×5: 5/5 commits, 0 destructive failures. Variance moved to quality layer, not correctness.
- **v1.32-a.5** — Pathology guard: after `PATHOLOGY_THRESHOLD=5` repeated errors → strategy nudge; after `MAX_PATHOLOGY_STRIKES=2` → hard bail. Wall-time bounded: 23 min vs 58 min outlier.
- **v1.32-a.6** — `prettier --write` on `writtenFiles` after validation pass, before commit. Cosmetic-only, never blocks commit.

Total tests added: +51. Running total: 441/441.

---

## v1.31 — Structural anchor edits (2026-04-29)

Six AST-aware tools: `add_method`, `replace_method`, `replace_function`, `add_route` (Fastify-aware), `add_import`, `add_export`. Replace line-coord `replace_in_file` for TS/JS edits. `/version` → byte-perfect via `add_route` in 3 calls / 12 min (vs 25 calls / 32 min on v1.30.5). `getSize()` placed INSIDE class by construction. **+62 tests, 356/356.** Bench: [2026-04-30-v1.31-structural-anchors.md](docs/benchmarks/runs/2026-04-30-v1.31-structural-anchors.md).

---

## v1.30 — Tool-calling Coder (2026-04-29) — Phase 3 entry

5 tools (`read_file` / `replace_in_file` / `create_file` / `delete_file` / `done`). `WorkingSet` with lazy disk read. `chatWithTools` with inline-content fallback parser for qwen2.5-coder/gemma2 quirk (tool calls in `content`, not structured). **v1.29 scale ceiling broken:** rag-system /version 0/10 → 5.2/10. `TOOL_CALLING_CODER=true` opt-in (became default in v1.32-d). **+31 tests, 254/254.**

Sub-iterations:
- **v1.30.1** — `extractAllowedPaths(taskDescription)` + `ALWAYS_FORBIDDEN_PATTERNS` (package.json, lockfiles, configs). Scope creep eliminated.
- **v1.30.3** — `ToolCallingFixerAgent` with issues-first signature.
- **v1.30.3.1** — `pruneHistory` keeps `system + initial task + last 16 messages`. First Fixer attempt completed without crash on 91-file project.
- **v1.30.4** — Cargo-cult prompt fix ("CONTENT COMES FROM THE TASK DESCRIPTION"). `/version` returned correct `{ version: '1.0.0' }` for the first time.
- **v1.30.5** — `checkBraceBalance` before/after replace; atomic undo via `WorkingSet.overwriteRaw` on imbalance.

---

## v1.29 — Scale validation on rag-system (2026-04-29) — Phase 3 trigger

Bench on 91-file TS project (65 with symbols, 6717 LOC). Indexing 3.5s / 210 vectors — OK. **Atomic L1' `/version`: 0/10** (5 search-not-found cascades — patch-based Coder hallucinates search blocks at medium scale). Phase 3 architectural shift necessary. Bench: [2026-04-29-v1.29-scale-rag-system.md](docs/benchmarks/runs/2026-04-29-v1.29-scale-rag-system.md).

---

## v1.28 — Partial completion events (2026-04-29)

New event `commit_partial` between `commit_skipped` and `done`. Tracks `unrecoveredWrites: string[]`; `done.data` extended with `{ partial, failedStepIds, unrecoveredWrites }`. Pure observability improvement. **+2 tests, 219/219.**

---

## v1.27 — Per-agent context tailoring (2026-04-29)

✅ Landed: Planner few-shot examples (multi-file feature → one coupled step). ❌ Reverted after empirical regression: lean Architect/Reviewer/Tester context — wall time 3–5× slower, L2.1 variance spiked `[10, 1]`. Architect's `design` field is load-bearing for Coder. Bench: [2026-04-29-v1.27-per-agent-context.md](docs/benchmarks/runs/2026-04-29-v1.27-per-agent-context.md).

---

## v1.26 — Few-shot examples in Coder/Fixer (2026-04-29)

Worked examples (input → output) instead of abstract prose rules. **L2.1 lifted from variance hell to deterministic 10/10** (mean 6.4 → 10.0, both runs byte-identical to Example A). Mean across 6 runs: 9.3/10. Bench: [2026-04-29-v1.26-few-shot.md](docs/benchmarks/runs/2026-04-29-v1.26-few-shot.md).

---

## v1.25 — Repo-map in every prompt (2026-04-28)

`buildRepoMap(graph, projectRoot, opts?)` with per-file relative path + indented signatures, token budget (default 6000 chars), `highlightFiles` pinned at top. **L2.3 cumulative first landed GREEN 9.2/10** (previous ceiling 5.0/10 partial commit). Bench: [2026-04-28-v1.25-repo-map.md](docs/benchmarks/runs/2026-04-28-v1.25-repo-map.md).

Sub-iterations:
- **v1.25.1** — Validation-Fixer write throws no longer crash the task.
- **v1.25.2** — Reindex prunes graph for deleted files (fixes "ghost files" in repo-map).

---

## v1.24 — Whitespace-tolerant edit matching (2026-04-28)

`applyEdits` strict-first → tolerant fallback with `\s+` normalisation; `tolerantEdits: number[]` in ApplyResult. Tolerant requires unique match (zero or ≥2 → abort). **+9 tests.** Bench: [2026-04-28-v1.24-whitespace-tolerant.md](docs/benchmarks/runs/2026-04-28-v1.24-whitespace-tolerant.md).

---

## v1.23 — Patch-based code editing (2026-04-27) — key safety win

`FileChange` discriminated union (`create | modify | delete`). For modify: array of `edits: Array<{search, replace}>`, no `content`. `applyEdits()` aborts on zero or multiple matches — atomic. **File is never corrupted, even on wrong edits. Main branch is protected.** L2.1 on qwen2.5-coder:32b → 10/10 GREEN. **+10 tests, 196/196.** Bench: [2026-04-27-v1.21-v1.23-multi-model.md](docs/benchmarks/runs/2026-04-27-v1.21-v1.23-multi-model.md).

Sub-iterations:
- **v1.23.1** — Entry-point files (server.ts/main.ts) always included in ragFilePaths.
- **v1.23.2** — `dedupeChangesByPath` (modify edits merged into one atomic apply).
- **v1.23.3** — Retry-with-real-content (Aider iterative editing pattern).

---

## v1.22 — Cross-step consistency (2026-04-27)

`previousChanges: FileChange[]` snapshot passed to `executeStep`. New block "Recently modified by previous steps — CURRENT state — SUPERSEDES Existing project files". Sub-iterations: v1.22.1 (Planner same-file sequential dependency rule), v1.22.2 (`const` exports indexing), v1.22.3 (Coder rules 9–13: entry-point preservation, no `require()` in ESM, file extension rule, Fastify quick reference; Tester explicit vitest mocking guide).

---

## v1.21 — Context fidelity & reliability (working baseline)

`ProjectConventions` module (testFramework, moduleType, tsStrict, runtimeFrameworks, entryPoints). `buildPromptContext` with 4 sections. **`COMMIT_ONLY_IF_VALID=true`** — git commit only on passing validation. **`TESTER_ENABLED`** flag. `PLANNER_MAX_STEPS=50` hard cap. Critical bugfixes: glob was not excluding node_modules in sandbox; Validator was using wrong projectRoot.

---

## v1.18 — VSCode Extension (first version)

12th monorepo package, esbuild → `dist/extension.js` (~18 KB). Activity bar with two TreeViews (Projects, Tasks); status bar with active project; commands: Run Task / Index / Register Project / Stream Progress; OutputChannel "RAG System" formats SSE events; polls /tasks every 5s. New API endpoint `POST /index`. **+12 tests.**

---

## v1.17 — Streaming Coder

`BaseAgent.streamLLM` AsyncIterable. `partial-json.ts` string-aware scanner with markdown fence support. `CoderAgent.execute(..., onFileReady?)` callback fires on each ready file. New event `coder_file_ready { stepId, path, action, size, index }`. **+14 tests.**

---

## v1.16 — MCP projects

MCP server uses the same `ProjectRegistry` + `ProjectManager` as the API. New tools: `list_projects`, `register_project`. Optional `project_id` on index_codebase / search_code / get_related_code / run_task / list_decisions / add_decision.

---

## v1.15 — Multi-project

`Project` model + `ProjectRegistry` (top-level SQLite at `data/projects.db`). `projectPaths(project)` — isolated layout `data/projects/<id>/{memory.db, vectors/, graphs/, backups/}`. `ProjectManager` lazy lifecycle. API endpoints: GET /projects, GET /project/:id, POST /project. **+23 tests.**

---

## v1.14 — Live indexing progress

Events `index_start | index_file | index_skip | index_done` on channel `task:<indexId>`. Throttle 200ms. MCP `index_codebase` returns indexId + stream URL. **+5 tests.**

---

## v1.13 — Tolerant JSON parsing

`tryParseJsonTolerant<T>` strict-first → 6 fixers (BOM, code-fence, extract-from-prose, comments, trailing-commas, escape-control-in-strings). Each fixer is string-aware. **+15 tests.**

---

## v1.12 — Parallel file indexing

`Semaphore` (FIFO, counting). `embedWithCache` wraps only the network round-trip. `indexCodebase` uses `pMap(files, fileConcurrency)`. `FILE_CONCURRENCY=4`, `EMBED_CONCURRENCY=8` give ~5–8× speedup on cold cache.

---

## v1.11 — Parallel embed

`pMap(items, n, mapper)` sliding-window pool in graph-retriever. `EMBED_CONCURRENCY=8` default. Cache hits do not hold a slot.

---

## v1.10 — Agent streaming

`OllamaClient.chatStream()` AsyncIterable with NDJSON parser. `BaseAgent.callLLM` now streaming internally (accumulates for backwards compat). `AsyncLocalStorage` for task context (taskId/stepId through 5 layers without signature changes). Event `agent_stream` throttle 120ms.

---

## v1.9 — DAG-aware parallelism

Independent steps run concurrently via `Promise.race`. `AGENTS_PARALLELISM=3` default. `detectCycles()` iterative DFS. Dangling deps → step marked skipped.

---

## v1.8 — Observability

`taskLogger(taskId)` pino child with taskId tagline. `BackupManager.prune(maxAgeMs)` — `BACKUP_MAX_AGE_DAYS=7` default. `setInterval` with `unref()`.

---

## v1.7 — MCP resources + prompts

Resources: `adr://recent`, `adr://{id}`, `failures://top`, `tasks://recent`. Prompts: `add-feature`, `fix-bug`, `refactor`, `add-tests` — model learns from past failures via MCP. **+14 tests.**

---

## v1.6 — Polyglot support

tree-sitter (0.25) + python/rust/go in `@rag-system/code-graph`. `ASTParser` dispatches by extension. Lazy load with graceful degradation. **+6 tests across 4 languages.**

---

## v1.5 — Live progress (SSE)

`TaskEventBus` (EventEmitter + ring buffer 200 events). Orchestrator emits `plan | step_start | step_complete | step_fail | step_skip | validation_* | commit | done`. `GET /task/:id/stream` — SSE with history replay → live → close. Heartbeat every 15s.

---

## v1.4 — Live indexing

FileWatcher (chokidar) with 1500ms debounce — auto re-indexes on IDE save. Clears deleted files from CodeGraph + VectorStore (`HNSW.markDelete`) + file_hashes. `WATCH_ENABLED=true` flag.

---

## v1.3 — Resilient orchestration

Per-step error recovery — a failed step does not kill the task. DAG-aware skip — steps with failed dependencies are skipped automatically. Partial completion in `tasks.result`. ADR + failure pattern recorded on each failure.

---

## v1.2 — Agent quality

TestRunner (`npm test` after write, with timeout). TypeChecker (`tsc --noEmit`). Validation loop in Orchestrator — Fixer receives real tsc/test errors. Embedding cache in SQLite (sha1 dedup).

---

## v1.1 — Reliability baseline

Zod validation of all agent output (protection against malformed LLM JSON). VectorStore async mutex + atomic write (.tmp + rename). `Promise.allSettled` in RAG loader. SQLite `close()` on graceful shutdown. `validateConfig()` at startup. vitest + 35 tests. Incremental indexing (SHA-1 hashes). MCP runtime validation. Fastify bodyLimit (64 KB) + rate-limit (60 req/min).

---

## v1.0 — Foundation (Iter 0–3)

**Iter 0:** Turborepo monorepo, 12 packages, package.json / tsconfig / turbo.json, clean `npm install` + `npm run build`.

**Iter 1:** Core — shared/types/config/logger; OllamaClient (`/api/chat`, `/api/embeddings`, healthCheck); MemoryStore (SQLite, tasks/adr/failures); SafeWriter + BackupManager + DiffEngine; MemoryQueue + JobWorker (graceful shutdown); Fastify API (/health, /task, /task/:id, /tasks).

**Iter 2:** RAG Engine — ASTParser (TS Compiler API: function/class/interface/type), CodeGraph with persistence; VectorStore (HNSW, cosine, labelMap); GraphRetriever (embed → search → 1-hop deps → token-bounded context); connected to Orchestrator.

**Iter 3:** MCP server — stdio transport, 7 tools (index_codebase, search_code, get_related_code, run_task, get_task_status, list_decisions, add_decision).
