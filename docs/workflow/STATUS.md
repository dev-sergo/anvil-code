# STATUS — Current iteration state

**Updated:** 2026-05-08
**Release target:** 2026-05-16 (Friday)
**Release readiness:** 55% (v1.34 closed, v1.35 decision pending)

---

## Where we are

| | |
|---|---|
| Last closed | v1.34 Hybrid search BM25+RRF — bench 2026-05-08 |
| In progress | — |
| Decision pending | v1.35 multi-hop closure (go / timebox 4d / skip) |
| Blocking release | GitHub prep + .vsix packaging |

---

## Phase 4 — Storage & retrieval upgrade

| Iteration | Status | Result |
|---|---|---|
| v1.33 — BGE-reranker | ✅ 2026-05-07 | L1.2/L1.3 2/3→3/3; precision@5 baseline |
| v1.34 — BM25+RRF hybrid | ✅ 2026-05-08 | L1.1 3/3 ✓; L4.1 2/3 (interceptToolCall ✓, no test-files) |
| v1.35 — multi-hop closure | ⬜ decision pending | — |

**Phase 4 closes after v1.35** (or by explicit skip decision).

---

## v1.34 bench summary (2026-05-08)

- L1.1 ×3: 3/3 completed, avg 77s — regression guard ✅
- L4.1 ×3: 2/3 completed, avg 157s — interceptToolCall ✅ (Fixer никогда не создавал тест-файлы)
- Infrastructure fixes: `git-engine` defaultBranch, bench script field names, Qwen3 thinking mode

---

## Iterations remaining to release (2026-05-16)

| Day | Task | Status |
|---|---|---|
| 2026-05-09 | v1.35 decision: go / timebox 4d / skip | ⬜ |
| 2026-05-09–12 | v1.35 (если go) | ⬜ |
| 2026-05-13 | GitHub OpenSource prep (README, LICENSE, CONTRIBUTING) | ⬜ |
| 2026-05-14 | VS Code .vsix packaging + smoke test | ⬜ |
| 2026-05-15 | Buffer + CHANGELOG/ROADMAP sync | ⬜ |
| 2026-05-16 | 🚀 Public release | ⬜ |

---

## Known gaps at release (without v1.35)

| Gap | Severity | Workaround |
|---|---|---|
| L2.x cross-file tasks на больших кодовых базах | MEDIUM | BM25 частично помогает |
| 1-hop only — transitive deps не видны | MEDIUM | Post-release v1.35 |
| HNSW JSON cap ~10K elements | LOW | Phase 5 Qdrant |
