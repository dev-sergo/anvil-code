# Run 2026-05-18 — Qwen3-35B MoE A3B (v1.61)

## Configuration

| | |
|---|---|
| Date | 2026-05-18 |
| rag-system revision | `69aa194` (v1.61) |
| LLM_LARGE_MODEL | `qwen3-32k` (Qwen3-35B-A3B MoE, 32K ctx, q4_0 KV) |
| LLM_SMALL_MODEL | `qwen3-32k` (same — Planner needs 32K for large vite RAG) |
| Speed | **11 tok/s** (2× faster than any dense 32B) |
| GPU | RTX 3090 24GB — model fully in VRAM (~21GB) |

## Sandbox Results — 7/7 ✅ (NEW RECORD)

| Task | Result | Note |
|------|--------|------|
| L1.1 — GET /health endpoint | ✅ | |
| L1.2 — Zod validation on POST /users | ✅ | |
| L1.3 — GET /users/:id/stats (accountAge) | ✅ | |
| L2.1 — Request-logging middleware | ✅ | |
| L2.3 — Soft delete (3 files) | ✅ | |
| L3.1 — Object literal → class refactor | ✅ | **Previously failing (TS2613)** — thinking mode fixed it |
| L4.1 — Fix 404 on user not found | ✅ | |

**7/7 — best sandbox result of the entire project.** Thinking mode helps Qwen3 understand multi-file consistency (L3.1 export/import matching, L2.3 type propagation).

## Vite Results — 3/4

| Task | Result | Note |
|------|--------|------|
| V1 — JSDoc on defineConfig (config.ts 2728 lines) | ✅ | **New!** Was model-ceiling for all dense models |
| V2 — getViteVersion new file | ✅ **committed `2b240b42`** | **v1.62 ESM guard fired** — retry produced `fileURLToPath(import.meta.url)` |
| V3 — parseAcceptHeader (utils.ts 1835 lines, modify) | ✅ **committed `386eb921`** | **v1.63 read_file offset** — Qwen3 navigated to line 1800, used add_export, 29 lines added 0 deleted |
| V5 — HMR_HEADER_NAME constant | ✅ | Consistent |
| V6 — createServer JSDoc (re-export chain) | ✅ | Was Gemma noop, now ✅ |

**Vite total: 5/5 ✅** (V1+V2+V3+V5+V6 — all pass with Qwen3 MoE + v1.63).

### V2 post-v1.62 detail

Two `coder_file_ready` events (415 bytes → 431 bytes) in SSE stream confirm ESM guard fired:
- Attempt 1: Coder generated `__dirname` without ESM preamble → `detectEsmProductionViolators()` caught it
- Retry: nudge listing `getViteVersion.ts` + correct `import` example → Coder produced ESM-compliant code
- Committed diff: `fileURLToPath(import.meta.url)` + `dirname()` pattern — idiomatic ESM `__dirname` replacement

## Speed benchmark (warm, 300 tokens)

| Model | tok/s |
|-------|-------|
| **Qwen3-35B MoE A3B (this run)** | **11.2** |
| Gemma-26B MoE A4B | 3.8 |
| qwen2.5-coder-32B Q6_K_L 16K | 3.4 |
| qwen2.5-coder-32B Q4_K_M 16K | 2.9 |

## Why Qwen3 MoE is faster

MoE architecture: only **3B active parameters** per forward pass (out of 35B total). Per token, GPU reads only ~3GB of weights (vs ~26GB for dense 32B). At 936 GB/s bandwidth: ~3ms/token theoretical vs ~28ms for dense. Practical gains limited by KV cache reads and overhead, but still 2-3× faster.

## Why thinking mode helps sandbox

Qwen3 generates reasoning tokens before producing output. For multi-file tasks like L3.1 (class refactor), the model "thinks through" import/export consistency, catching the TS2613 mismatch that stumped all dense models. For simple tasks, thinking adds ~100-500 token overhead but doesn't slow wall-clock time much at 11 tok/s.

## Remaining blockers

~~1. **V3 (utils.ts 1835 lines)**: Fixed in v1.63 — `read_file` offset + truncation nudge guides model to use `add_export`.~~ ✅
~~2. **V2 (ESM compliance)**: Fixed in v1.62 — `detectEsmProductionViolators` + retry nudge.~~ ✅

**No remaining blockers. Vite 5/5.**
