# Run 2026-05-16 — Cross-Repo Bench: vite (v3, v1.54)

## Configuration

| | |
|---|---|
| Date | 2026-05-16 |
| Repo | `vitejs/vite` (monorepo, ~1413 files) |
| rag-system revision | `755ff4b` (v1.54) |
| Mode | balanced |
| LLM_LARGE_MODEL | `gemma` (gemma-4-26b-a4b-it-mxfp4-moe-ctx-32k) |
| LLM_SMALL_MODEL | `qwen3` (qwen3-6-35b-a3b ctx-16k) |
| Backend | llama-swap @ 172.20.10.4:8080 |
| Setup | `pnpm build` run before bench |
| Changes vs v2 bench | v1.54: `git clean -fd` before task branch; TesterAgent rules 13-14 (async hooks, static imports) |

## Results

| Task | Result | Pattern | Time |
|------|--------|---------|------|
| V1 — JSDoc on defineConfig | ❌ error | llama-swap 400 (25718 tok > model ctx) | ~30s |
| V2 — getViteVersion helper (new file) | ✅ **committed** | `bde4b98` — clean create, no broken test | ~1min |
| V3 — parseAcceptHeader in utils.ts | ❌ error | llama-swap 400 (21417 tok > ctx) | ~5.5min |
| V4 — requestLogger middleware | ❌ error | Reviewer: wrong `createLogger` import | ~5.5min |
| V5 — HMR_HEADER_NAME constant | ✅ **committed** | placed near CLIENT_PUBLIC_PATH constants | ~1.5min |
| V6 — JSDoc on createServer | ❌ noop | Coder 0 file changes (re-export chain) | ~2min |

**2/6 commits** — V2 and V5. Up from 0/6 (v1.52) → 1/6 (V5c on v1.53) → 2/6 (v1.54).

## Analysis

### V2 ✅ — dirty-tree fix + TesterAgent rules worked

Previous failure: TesterAgent generated `await import(...)` inside synchronous `beforeEach` → SyntaxError → commit_skipped.
With v1.54:
- `git clean -fd` before branch creation → no leftover spec files from prior tasks
- TesterAgent rule 14 → static imports only; rule 13 → async hooks must be `async`
- Result: Coder created `packages/vite/src/node/utils/getViteVersion.ts` cleanly
- TesterAgent skipped or its file was rejected by `validateAndFilterTestFiles`; either way no bad test blocked commit

**Diff:** pure new file, 8 lines, correct `fs.readFileSync` + `JSON.parse` implementation.

### V5 ✅ — consistent (v1.53 fix holds)

`HMR_HEADER_NAME = 'x-vite-hmr'` placed near `CLIENT_PUBLIC_PATH` constants (line ~120) — better
positioning than v1.53 run (which placed it at end of file). Committed cleanly in ~90s.

### V1 — new failure pattern (llama-swap 400, 25718 tokens)

JSDoc on `defineConfig` (config.ts). RAG retrieved a large slice of config.ts → Planner prompt
exceeded 25718 tokens → llama-swap 400. Previously was `llm_parse_fail`. Both are model-level
failures; context budget for this specific task is too large for the qwen3 16K small model path.

### V3 — same context ceiling (21417 tokens)

`utils.ts` 1835 lines. llama-swap 400 (21417 tok). Unchanged from v1.52/v1.53.

### V4 — Reviewer correctly rejected (wrong import)

Coder produced a middleware implementation but imported `createLogger` incorrectly. Reviewer caught it
and rejected after 3 Fixer attempts. Fixer couldn't resolve the import chain. This is a code-quality
failure, not infra — progress vs v1.52 where it was "code identical to original".

### V6 — navigation noop (unchanged)

`createServer` re-export chain: Coder produced 0 edits after noop retry. Same as all previous runs.

## Progression summary

| Metric | v1.52 (baseline) | v1.53 | v1.54 (this run) |
|--------|-----------------|-------|-----------------|
| Commits | 0/6 | 1/6 (V5 isolated) | **2/6** |
| V2 (new file) | ❌ vitest crash | ❌ bad test (await) | ✅ committed |
| V5 (constant) | ❌ e2e timeout | ✅ | ✅ |
| V1 (JSDoc) | ❌ llm_parse_fail | ❌ | ❌ 25K ctx |
| V3 (large file) | ❌ 18K ctx | ❌ 19K ctx | ❌ 21K ctx |
| V4 (middleware) | ❌ noop | ❌ noop | ❌ wrong import |
| V6 (re-export) | ❌ noop | ❌ noop | ❌ noop |

## Remaining blockers

1. **Context ceiling** (V1, V3): RAG context + file content > 16K for small model, or > 32K for
   Gemma. Needs 32K aux model for Reviewer/Tester, or RAG_MAX_CONTEXT_TOKENS tuning per-repo.
2. **Large-file navigation** (V4, V6): Coder can't reliably locate attach points in files >1000 lines
   without a precise anchor. Structural anchor v3 (give file content in error) may help.
3. **V2 test coverage gap**: `getViteVersion.ts` committed without tests (TesterAgent output was
   filtered or skipped). Acceptable for now but ideally Tester should generate a valid static-import test.

---

# L6 Spot-Check — v1.55 regression test (2026-05-16)

| Task | Result | Note |
|------|--------|------|
| L6.2 — query() JSDoc (request.ts 489 lines) | ✅ committed | No regression, 1:45 wall time |
| L6.4 — redirect() property arrow (context.ts 780 lines) | ❌ noop | Same model-limit as v1.50 |
| L6-simple — status() property arrow (context.ts 780 lines) | ❌ noop | Same file, same root cause |

**v1.55 verdict:** Fix is correct for property arrow in files <~500 lines where model calls `replace_method`. For context.ts (780 lines), RAG context exceeds Gemma's effective engagement threshold → no tool calls at all → fix never fires. L6 baseline remains **3/4 (75%)**, same as v1.50. Needs 32K aux model to improve L6.4.
