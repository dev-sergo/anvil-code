<p align="center">
  <img src="assets/banner.svg" alt="Anvil-Code banner" width="820"/>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-orange.svg" alt="MIT License"/></a>
  <img src="https://img.shields.io/badge/TypeScript-5.4+-3178c6.svg" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/Node.js-18+-339933.svg" alt="Node.js"/>
  <img src="https://img.shields.io/badge/tests-534%20passed-22c55e.svg" alt="534 tests"/>
  <img src="https://img.shields.io/badge/bench%20sandbox-87.5%25-22c55e.svg" alt="87.5% sandbox"/>
  <img src="https://img.shields.io/badge/bench%20real--repo-38%25-f97316.svg" alt="38% real repos"/>
</p>

---

Local AI assistant for TypeScript development. Submit a task in plain English; the system plans, writes code, validates, and commits — entirely on your machine. No cloud, no subscriptions, no telemetry.

```
POST /task  →  Planner  →  Coder  →  Tester  →  Reviewer  →  Fixer (retry ×3)  →  git commit
```

Designed for solo developers who want an autonomous coding agent that runs on their own GPU. Built on llama.cpp / llama-swap, so any GGUF model with an OpenAI-compatible endpoint works.

---

## What it does (and what to expect)

The system is good at:

- **Adding new files** — utility modules, middleware, helpers. ~90% success on sandbox tasks.
- **JSDoc / TSDoc and small edits** — adding types, comments, simple refactors inside a single file.
- **Adding a route or endpoint** — Fastify-style `app.METHOD(...)` registrations with handler + validation.
- **Bugfixes localized to one file** — when the failing test points unambiguously at the fix site.
- **Indexing and searching your repo** — hybrid BM25 + dense vector retrieval with AST graph traversal.

The system is **not yet good at**:

- **Large class surgery** — files over ~700 lines confuse the tool-calling Coder; structural anchor lookups drift.
- **Complex generic refactors** — generic-heavy TypeScript (e.g. tRPC-style builders) frequently exceeds context.
- **Cross-service refactoring** — multi-file consistency rewrites (rename a method across 8 files) often miss callsites.
- **Cumulative state across tasks** — task N+1 cannot reliably build on task N's output yet. Each task is independent.

Honest numbers, last bench (v1.37, May 2026):

| Target                              | Tasks | Pass rate |
|-------------------------------------|-------|-----------|
| `rag-system-sandbox` (curated bench, 30 files) | L1–L5 | **87.5 %** (14/16) |
| `honojs/hono` (real OSS, ~150 files)            | L1–L3 | **38 %** (varies) |
| `trpc/trpc` (real OSS, ~200 files)              | L1–L3 | **38 %** (varies) |

See [BENCHMARK.md](BENCHMARK.md) for full methodology, failure modes, and per-task results.

---

## Requirements

| | Minimum |
|---|---|
| Node.js | 18 LTS |
| npm | 9+ |
| Git | 2.30+ |
| RAM | 16 GB |
| GPU VRAM | **24 GB** (for the recommended Gemma 4 26B coder) — 16 GB works with smaller models at lower success rate |
| LLM backend | [llama-swap](https://github.com/mostlygeek/llama-swap), llama-server, or any OpenAI-compatible `/v1/chat/completions` endpoint |

Tested model stack (recommended):

| Role | Alias | Model |
|---|---|---|
| Large (coder / fixer / architect) | `gemma` | gemma-4-26b-a4b-it-mxfp4-moe-ctx-32k |
| Small (planner / reviewer / tester) | `qwen3` | qwen3-35B-A3B MoE (3 B active) |
| Embed | `embed` | nomic-embed-text-v1.5 (768 dim) |
| Reranker (optional) | `reranker` | bge-reranker-v2-m3 |

A capable Mac Studio / RTX 4090 box keeps all of these in VRAM with llama-swap handling load/unload between roles.

---

## Quickstart (5 steps)

### 1. Run an LLM backend

Install [llama-swap](https://github.com/mostlygeek/llama-swap), put your GGUFs in `~/models/`, declare the aliases above in `config.yaml`, and start the proxy. It exposes a single OpenAI-compatible endpoint that load-swaps models in VRAM on demand.

See [docs/SETUP.md](docs/SETUP.md) for the full llama-swap config we benchmark against.

### 2. Clone, install, build

```bash
git clone https://github.com/BubnovSA/anvil-code.git
cd anvil-code
npm install
npm run build
```

### 3. Configure `.env`

```bash
cp .env.example .env
```

Edit at minimum:

```env
LLM_URL=http://localhost:8080        # your llama-swap endpoint
LLM_LARGE_MODEL=gemma                # validated default since v1.35
PROJECT_ROOT=/absolute/path/to/your/repo
```

Every variable in `.env.example` is documented inline.

### 4. Start the API server

```bash
npm run start
```

Server starts on `http://localhost:3000`. Verify:

```bash
curl http://localhost:3000/health
# {"status":"ok","backend":"llamacpp","backendUp":true,"uptime":...}
```

### 5. Submit a task

**Via VS Code extension (recommended):**

```bash
cd packages/vscode-extension
npm run package      # produces rag-system-vscode-*.vsix
```

In VS Code: **Extensions → ⋯ → Install from VSIX…** Pick the `.vsix`, then run **RAG System: Submit Task** from the command palette. Pick project + mode in the prompts and watch the SSE stream in the **RAG System** output channel.

**Via curl:**

```bash
# Register the project once
curl -X POST http://localhost:3000/project \
  -H "Content-Type: application/json" \
  -d '{"root": "/absolute/path/to/your/repo"}'

# Submit a task (replace <id> with the project id returned above)
curl -X POST http://localhost:3000/task \
  -H "Content-Type: application/json" \
  -d '{"task": "Add request-id middleware to the Fastify server", "project": "<id>", "mode": "balanced"}'

# Stream events (Server-Sent Events)
curl -N http://localhost:3000/task/<task_id>/stream
```

---

## Limitations

- **TypeScript / JavaScript first.** Python, Rust, Go are parsed for context (tree-sitter), but the structural edit tools (`add_method`, `replace_function`, …) are TS-native. Other languages fall back to line-based edits with lower success rate.
- **Context window: ~16 K tokens.** With 24 GB VRAM and 26 B models, this is the hard ceiling for what fits per request. Tasks needing more get truncated retrieval — the system retrieves top-K, not the whole repo.
- **Single machine, single user.** No auth, no multi-user isolation, no remote workers.
- **No streaming agent tokens (yet).** The SSE endpoint streams structured events (plan, step, file, validation, commit, done), not raw LLM tokens.
- **Fixer is probabilistic.** The validation loop retries up to 3× on test/type failures. If it doesn't converge, `COMMIT_ONLY_IF_VALID=true` (default) leaves changes on an `auto/task-*` branch uncommitted rather than landing broken code.
- **Cumulative tasks regress on local 32 B models.** Submitting task N+1 that builds on task N's output is unreliable — design limitation of the model class, not the orchestrator.

---

## Architecture

Turborepo monorepo of 12 TypeScript packages. The API (Fastify) accepts tasks and queues them for an async Worker. The Worker calls the Orchestrator, which runs agents in sequence:

1. **Planner** decomposes the task into a DAG of typed steps.
2. **Architect** plans file-level changes (where applicable).
3. **Coder** (tool-calling) reads files, makes structural edits via `read_file` / `replace_in_file` / `create_file` / `delete_file`.
4. **Tester** generates tests for new code.
5. **Validation loop**: TypeScript check → test run → if failing, **Fixer** retries (max 3).
6. **Reviewer** does a final lenient pass — blocks only on runtime bugs, not style.
7. **Git Engine** commits to an `auto/task-*` branch.

Context is supplied by a **RAG Engine** combining an HNSW vector index, a BM25 keyword index (merged via RRF), and a 1-hop graph traversal over an AST-derived code graph.

Full diagram and per-package responsibilities: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Documentation

- [docs/SETUP.md](docs/SETUP.md) — installing llama-swap, model picks, hardware notes
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — agents, data flow, package map
- [BENCHMARK.md](BENCHMARK.md) — methodology + raw numbers
- [ROADMAP.md](ROADMAP.md) — current iteration, known limitations, next 2–3 versions
- [CHANGELOG.md](CHANGELOG.md) — version history (v1.0 → v1.38)

---

## Contributing

This is primarily a personal project, but contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
