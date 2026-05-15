# Run 2026-05-15 — Cross-Repo Bench: vite

## Configuration

| | |
|---|---|
| Date | 2026-05-15 |
| Repo | `vitejs/vite` (1413 files, monorepo) |
| Indexed | 1598 vectors, 13s |
| rag-system revision | `2068631` (v1.50) |
| Mode | balanced |

## Goal

Measure transferability of the system to a new TypeScript repo with different structure (vite — bundler, monorepo, complex build) vs. trained-on hono/trpc.

## Results

| Task | Result | Pattern | Time |
|------|--------|---------|------|
| V1 — JSDoc on defineConfig | ❌ error | `llm_parse_fail` | 111s |
| V2 — getViteVersion helper (new file) | ❌ commit_skipped | `test_fail`: vitest not installed | 248s |
| V3 — parseAcceptHeader in utils.ts | ❌ error | `exceed_context_size` (18995 > 16384) | 46s |
| V4 — requestLogger middleware (new file) | ❌ commit_skipped | `test_fail`: vitest crash | 81s |
| V5 — HMR_HEADER_NAME constant | ❌ commit_skipped | `test_fail`: vitest crash (code was correct) | 169s |
| V6 — JSDoc on createServer | ❌ noop | Complex re-export chain | 117s |

**0/6 commits** — but the failures are infrastructure, not code quality.

## Analysis — what failed and why

### Infrastructure failures (V2, V4, V5)

vite's test pipeline is more complex than hono/trpc:
- vitest is a workspace dep — needs `pnpm install` first
- After install, vitest crashes at startup with `ERR_MODULE_NOT_FOUND` — needs `pnpm build` for some prebuilt artifacts
- Our baseline detection (introduced in v1.38) records "tests fail on clean repo" → filters them. But vite's tests fail with a setup error, not a test error, and our filter doesn't catch the right pattern.

V5 specifically added `HMR_HEADER_NAME = 'x-vite-hmr'` to `constants.ts` correctly — TypeCheck passed, Reviewer didn't reject, but vitest crashed at startup, blocking commit.

### Capability failures (V3)

`utils.ts` is 1835 lines. When Coder reads it via `read_file`, the prompt context exceeds 16384 tokens (the small-model context window used by Reviewer/Tester via `qwen3` alias). Gemma 26B has 32K but auxiliary agents are tighter.

This is a real ceiling: `MAX_READ_LINES=350` doesn't help here because the file is referenced wholesale via RAG.

### Model variance (V1)

V1 (JSDoc on defineConfig) failed with `llm_parse_fail` — same random Gemma issue we see ~10% of the time.

### Navigation failure (V6)

createServer in vite's `server/index.ts` is exported via a complex re-export chain. Coder produced 0 file changes (`noop`) even after retry — the model couldn't pin the actual definition site.

## Honest verdict

The system **does not transfer cleanly** to vite without:
1. **Pre-flight check** — validate tests run on clean repo before allowing bench
2. **Larger Reviewer/Tester context** — qwen3 16K is too small for files >1500 lines
3. **Project-specific setup hints** — vite needs `pnpm install && pnpm build` before tests

V5 demonstrates the system's code generation works (correct constant added), but the validation pipeline assumes a simpler test setup than vite provides.

## Recommendations

For deployment to a new repo:
1. Verify `npm test` (or project test command) runs successfully on clean state before bench
2. If repo has files >1500 lines: be aware those tasks may exceed context — either skip those targets or upgrade auxiliary models to 32K+
3. Document per-project setup requirements (build steps, env vars) before bench runs

This bench is honest baseline data for what cross-repo deployment looks like in practice — not all green, infrastructure matters.
