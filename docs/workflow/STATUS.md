# STATUS — Current iteration state

**Updated:** 2026-05-08
**Release target:** 2026-05-16 (Friday)
**Release readiness:** 15% (pre-v1.34)

---

## Where we are

| | |
|---|---|
| Last closed | v1.33 Phase A+B+C — BGE-reranker (2026-05-07) |
| In progress | L4.1 micro-fix — Fixer scope (interceptToolCall) |
| Next | v1.34 Hybrid search (BM25 + RRF) |
| Blocking release | v1.34 (precision@5 = 0% is public-facing failure) |

---

## Current iteration: L4.1 micro-fix (today, 2026-05-08)

**Goal:** Fixer must not create test files when stuck on a bug (L4.1 regression 1/3 → target 3/3).

**Root cause:** Fixer в pathology-bail path вызывает `create_file('src/__tests__/user-service.test.ts')`. Scope policy в `buildBugFixAllowedSet` фильтрует test paths из allowed, но не блокирует `create_file` на новые test paths абсолютно.

**Fix:** `interceptToolCall` hook в `TaskAgentSpec` — hard veto до `dispatchToolCall`. BUGFIX_SPEC блокирует `create_file` на любой test path с redirect к production module.

**Changes:**
- `packages/agents/src/task-agents/spec.ts` — `interceptToolCall?` optional hook
- `packages/agents/src/task-agents/runner.ts` — check before dispatch
- `packages/agents/src/task-agents/bugfix.ts` — blocks `create_file` for isTestPath
- `packages/agents/src/__tests__/task-agents.test.ts` — 5 new tests

**Status:** ✅ Implemented, running tests

---

## Next: v1.34 Hybrid search (BM25 + dense with RRF)

**Motivation:** precision@5 = 0/3 на target. Dense-only не находит `src/server.ts` по запросу "add request-logging middleware". BM25 по symbol names + path components закроет vocabulary gap.

**Scope:**
- Pure-TS BM25 index (no external deps)
- RRF merge: `score = 1/(60 + rank_dense) + 1/(60 + rank_bm25)`
- Exclude `data/backups/**` from indexing (bench noise)

**ETA:** 2 days (design 2026-05-08, impl 2026-05-09–10, bench 2026-05-11)
**Design:** [docs/designs/v1.34-hybrid-search.md](../designs/v1.34-hybrid-search.md) — needed before code

---

## Iterations remaining to release (2026-05-16)

| Day | Task | Status |
|---|---|---|
| 2026-05-08 | L4.1 Fixer micro-fix | 🔄 in progress |
| 2026-05-08–09 | v1.34 design + impl | ⬜ |
| 2026-05-10 | v1.34 bench | ⬜ |
| 2026-05-11–12 | Dogfood bench on rag-system-target | ⬜ |
| 2026-05-13 | GitHub OpenSource prep (README, LICENSE, CONTRIBUTING) | ⬜ |
| 2026-05-14 | VS Code extension: .vsix package + smoke test | ⬜ |
| 2026-05-15 | Buffer + polish | ⬜ |
| 2026-05-16 | 🚀 Public release | ⬜ |
