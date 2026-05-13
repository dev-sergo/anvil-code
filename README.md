<p align="center">
  <img src="assets/banner.svg" alt="Anvil-Code banner" width="820"/>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-orange.svg" alt="MIT License"/></a>
  <img src="https://img.shields.io/badge/TypeScript-5.4+-3178c6.svg" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/Node.js-18+-339933.svg" alt="Node.js"/>
  <img src="https://img.shields.io/badge/tests-534%20passed-22c55e.svg" alt="534 tests"/>
  <img src="https://img.shields.io/badge/packages-12%20clean-22c55e.svg" alt="12 packages"/>
  <img src="https://img.shields.io/badge/sandbox-87.5%25-22c55e.svg" alt="87.5% sandbox"/>
  <img src="https://img.shields.io/badge/real--repo-38%25-f97316.svg" alt="38% real repos"/>
</p>

<p align="center">
  <em>Local autonomous coding agent for TypeScript — submits tasks, plans, writes code, validates, and commits.<br/>
  Runs on your own GPU. No cloud. No subscriptions. No telemetry.</em>
</p>

```
POST /task → Planner → Architect → Coder → Tester → Reviewer → Fixer ×3 → git commit
```

---

## Benchmark

> All numbers from v1.37–v1.38 bench runs. Raw data: [BENCHMARK.md](BENCHMARK.md)

### By target codebase

| Target | Files | Tasks | 🟢 Pass | 🔴 Fail | Rate |
|--------|-------|-------|---------|---------|------|
| `rag-system-sandbox` (curated) | ~30 | 16 | **14** | 2 | 🟢 **87.5 %** |
| `honojs/hono` (real OSS) | 326 | 9 | **~3** | ~6 | 🟡 **~38 %** |
| `trpc/trpc` (real OSS) | 714 | 9 | **~3** | ~6 | 🟡 **~38 %** |

### By task category (sandbox)

| Category | Description | Sandbox | Combined | Rating |
|----------|-------------|---------|----------|--------|
| **A — Additive** | New file, new endpoint, new service | 4 / 4 | 6 / 6 | 🟢 **100 %** |
| **B — Structural** | Class extraction, generic refactor | 2 / 2 | 4 / 4 | 🟢 **100 %** |
| **C — Algorithmic** | LRU, TTL, SSE, auth logic | 2 / 2 | 3 / 3 | 🟢 **100 %** |
| **D — Maximum** | CQRS, architectural split, cross-file | 1 / 2 | 1 / 3 | 🔴 **33 %** |
| **Total** | | **9 / 10** | **14 / 16** | 🟢 **87.5 %** |

### By number of files touched

| Files changed | Success rate | Note |
|---|---|---|
| 1 – 2 | 🟢 ~100 % | Near-perfect; scope fits context |
| 3 – 4 | 🟢 ~85 % | Good; minor integration misses |
| 4 – 5 new abstractions | 🟡 ~70 % | Reviewer becomes the gating factor |
| 5 + architectural | 🔴 ~30 % | Context or scope overrun |

### Real-repo failure analysis (18 tasks on hono + trpc, before sprint fixes)

| Failure pattern | hono | trpc | Total | % | Fix |
|---|---|---|---|---|---|
| `exceed_context_size` | 3 | 3 | **6** | 🔴 33 % | `MAX_READ_LINES=350`, `HISTORY_KEEP_TAIL=4` |
| `test_fail:snapshot` (destructive side-edits) | 4 | 0 | **4** | 🔴 22 % | RAG paths read-only for Coder |
| `ts_precheck_fail` (pre-existing TS errors) | 0 | 3 | **3** | 🟡 17 % | Baseline detection before first task |
| `validation_fail:ts` | 1 | 1 | **2** | 🟡 11 % | `runOn(prodPaths)` filtering |
| `reviewer_reject` | 1 | 1 | **2** | 🟡 11 % | Lenient reviewer (v1.36) |
| `llm_parse_fail` | 0 | 1 | **1** | 🟢 6 % | JSON repair in Planner |

### Before → after sprint fixes (D1 → D2)

| Metric | Day 1 | Day 2 (after fixes) | Δ |
|---|---|---|---|
| Real-repo commits (18 tasks) | 🔴 **0 / 18** | 🟡 **6 / 16** | **+38 pp** |
| Context overflow rate | 🔴 33 % | 🟢 ~8 % | −25 pp |
| Destructive side-edits | 🔴 22 % | 🟢 0 % | −22 pp |
| Pre-existing failures blocking commit | 🔴 17 % | 🟢 ~2 % | −15 pp |

---

## What it handles — and what it doesn't

| Task type | Result | Notes |
|---|---|---|
| Add new utility file / module | 🟢 ~100 % | Single-file scope, no callsite changes |
| Add Fastify route + handler | 🟢 ~95 % | Structural anchor insert works reliably |
| JSDoc / TSDoc annotation | 🟢 ~100 % | Read-only analysis, minimal writes |
| Bugfix (test → one file) | 🟢 ~90 % | Clear signal from failing test |
| LRU / TTL / algorithmic logic | 🟢 ~90 % | Model generates correct structures |
| Multi-file feature (2–4 files) | 🟡 ~70 % | Some cross-file integration gaps |
| Refactor across 5+ files | 🔴 ~30 % | Context window + 1-hop graph limit |
| Large class surgery (>700 LOC) | 🔴 ~25 % | Anchor lookup drifts on long files |
| Complex generics (tRPC-style) | 🔴 ~20 % | Type graph exceeds retrieval budget |
| Cumulative chained tasks | 🟡 ~50 % | Unreliable on local 32 B models |

---

## Requirements

| Component | Minimum | Recommended |
|---|---|---|
| Node.js | 18 LTS | 20+ |
| npm | 9+ | 10+ |
| Git | 2.30+ | any recent |
| RAM | 16 GB | **32 GB** |
| GPU VRAM | 16 GB (smaller models, lower accuracy) | **24 GB** (Gemma 4 26B) |
| LLM backend | llama-server / any OpenAI-compatible API | [llama-swap](https://github.com/mostlygeek/llama-swap) |
| OS | macOS 13+, Linux (Ubuntu 22.04+) | macOS M2+ or Linux CUDA |

> 24 GB GPU VRAM is what the benchmarks above are measured against.  
> 32 GB system RAM is recommended to keep OS + dev tooling running while the GPU is loaded.

### Validated model stack

| Role | Alias | Model | VRAM |
|---|---|---|---|
| Coder / Fixer / Architect | `gemma` | gemma-4-26b-a4b-it-mxfp4-MoE ctx-32k | ~14 GB |
| Planner / Reviewer / Tester | `qwen3` | qwen3-35B-A3B MoE (3 B active) | ~22 GB |
| Embeddings | `embed` | nomic-embed-text-v1.5 (768 dim) | ~0.1 GB |
| Reranker *(optional)* | `reranker` | bge-reranker-v2-m3 | ~0.4 GB |

llama-swap auto-loads models in VRAM on demand and unloads idle ones — `gemma` and `qwen3` fit concurrently on a 24 GB card with KV cache compression.

---

## Quickstart

### 1. Run an LLM backend

Install [llama-swap](https://github.com/mostlygeek/llama-swap), point it at your GGUFs, declare the aliases above, and start the proxy. Full setup guide: [docs/SETUP.md](docs/SETUP.md).

### 2. Clone, install, build

```bash
git clone https://github.com/BubnovSA/anvil-code.git
cd anvil-code
npm install && npm run build
```

### 3. Configure

```bash
cp .env.example .env   # every variable is documented inline
```

Key variables:

```env
LLM_URL=http://localhost:8080   # llama-swap endpoint
LLM_LARGE_MODEL=gemma           # validated default (87.5% on sandbox)
PROJECT_ROOT=/path/to/your/repo
```

### 4. Start

```bash
npm run start
# → http://localhost:3000
curl http://localhost:3000/health
```

### 5. Submit a task

**VS Code extension** *(recommended)*:

```bash
cd packages/vscode-extension && npm run package
# Install the .vsix → Extensions → ⋯ → Install from VSIX
```

Run **RAG System: Submit Task** from the command palette. Pick project, pick mode, watch SSE stream in the output channel.

**curl**:

```bash
# One-time: register the project
curl -X POST http://localhost:3000/project \
  -H "Content-Type: application/json" \
  -d '{"root": "/path/to/your/repo"}'

# Submit
curl -X POST http://localhost:3000/task \
  -H "Content-Type: application/json" \
  -d '{"task": "Add request-id middleware", "project": "<id>", "mode": "balanced"}'

# Stream events live
curl -N http://localhost:3000/task/<task_id>/stream
```

---

## How it works

The pipeline is fully deterministic — every step is logged and events stream to the VS Code output channel in real time.

1. **Planner** — decomposes the task into a typed DAG of steps (`feature` / `bugfix` / `refactor`)
2. **Architect** — decides which files need creating, modifying, or deleting
3. **Coder** *(tool-calling)* — reads files, applies edits via `read_file` / `replace_in_file` / `create_file` / `delete_file`
4. **Tester** — generates tests for new code (vitest / jest based on project conventions)
5. **Validation** — TypeScript check (filtered to changed production files) → test run
6. **Fixer** — retries up to 3× on failures, targeting exact compiler errors and test output
7. **Reviewer** — final lenient gate: blocks only on runtime bugs, not style
8. **Git Engine** — commits to `auto/task-*` branch; skips commit if validation never converged

Context is supplied by a **RAG Engine**: hybrid BM25 + HNSW dense retrieval (RRF merge) → 1-hop AST graph expansion → token-budgeted output.

---

## Known limitations

| Limitation | Severity | Status |
|---|---|---|
| Real-repo success rate ~38 % | High | Ongoing — next: multi-hop retrieval, scope tightening |
| Large class surgery (>700 LOC) | High | Backlog — better anchor disambiguation |
| Complex generic refactors (tRPC) | High | Limited by 32 K context ceiling |
| Cross-service refactoring | High | 1-hop graph only; multi-hop in v1.41+ |
| Cumulative task chaining | Medium | Unreliable on 32 B local models |
| TypeScript / JS only (structural tools) | Medium | Python/Rust/Go parsed for context but not structurally edited |
| Single machine, single user | Low | By design for local use |

---

## Documentation

| File | Contents |
|---|---|
| [BENCHMARK.md](BENCHMARK.md) | Full methodology, all task results, failure analysis |
| [docs/SETUP.md](docs/SETUP.md) | llama-swap install, model picks, hardware |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Agent pipeline, packages, how to extend |
| [ROADMAP.md](ROADMAP.md) | Current iteration, next steps, known issues |
| [CHANGELOG.md](CHANGELOG.md) | Version history v1.0 → v1.38 |

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and coding conventions.

The project uses a benchmark-driven approach — if you change agent behavior, run the relevant bench level against the sandbox and include results in the PR. Bench tasks are in [docs/benchmarks/tasks.md](docs/benchmarks/tasks.md).

---

## License

**MIT** — [full text](LICENSE)

In practice, this means:

- ✅ **Use freely** in personal and commercial projects
- ✅ **Modify** the source code however you like
- ✅ **Distribute** copies, modified or unmodified
- ✅ **No royalties**, no asking permission
- ⚠️ **Keep attribution** — the original license and copyright notice must appear in copies or significant portions
- ⚠️ **No warranty** — the software is provided as-is; the author is not liable for damages

Copyright © 2026 BubnovSA. Built with [llama.cpp](https://github.com/ggerganov/llama.cpp) and [llama-swap](https://github.com/mostlygeek/llama-swap).
