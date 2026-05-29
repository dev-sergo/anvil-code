# Architecture

Turborepo monorepo of 12 TypeScript packages. The system is a request-driven pipeline: the API accepts a task, queues it, and an Orchestrator walks it through a chain of LLM-backed agents until the result is committed (or skipped, if validation fails).

## Data flow — task to commit

```
┌───────────┐
│ POST /task│
└─────┬─────┘
      │ task description, project id, mode
      ▼
┌─────────────────┐         ┌──────────────┐
│  api/server.ts  │ ──────► │ job-system    │
│  (Fastify)      │  queue  │ (MemoryQueue) │
└─────┬───────────┘         └──────┬───────┘
      │ SSE /task/:id/stream       │ worker dequeues
      ▼                            ▼
┌──────────────────────────────────────────────┐
│             agents/orchestrator              │
│                                              │
│  1. Planner       — decompose to DAG of steps│
│  2. Architect     — file-level plan          │
│  3. Coder         — tool-calling edits       │
│       │  read_file / replace_in_file /       │
│       │  create_file / delete_file / done    │
│  4. Tester        — generate tests           │
│  5. ValidationLoop                           │
│       │  TypeScript check (filtered to       │
│       │  changed prod paths)                 │
│       │  Test runner (vitest / jest)         │
│       │  Fixer ×3 if failing                 │
│  6. Reviewer      — lenient gate (blocks     │
│                     only on runtime bugs)    │
│  7. Git Engine    — commit to auto/task-*    │
└──────────────────────────────────────────────┘
      │ events all the way through:
      │   queued / running / plan / step_start /
      │   coder_file_ready / validation_pass /
      │   commit / done
      ▼
   SSE clients (VS Code extension, curl -N)
```

Every agent reads from a shared **RAG Engine** that combines an HNSW vector index, a BM25 keyword index (merged via RRF), a 2-hop graph traversal (forward deps + reverse callers) over an AST-derived code graph, and a pinned monorepo meta item (tsconfig paths + package exports) for correct workspace import generation.

All file writes go through **Safe Exec** (backup → diff → write) and only land via **Git Engine** at the very end.

## Agent responsibilities

| Agent     | Input                                | Output                                                     | Notes |
|-----------|--------------------------------------|------------------------------------------------------------|-------|
| Planner   | Task description, repo summary       | DAG of typed steps (`feature` / `bugfix` / `refactor`)     | Hard cap `PLANNER_MAX_STEPS` |
| Architect | Step description, retrieval context  | File-level plan (which files to create / modify / delete)  | Skipped for atomic steps |
| Coder     | Step + retrieval context             | Sequence of tool calls; emits `coder_file_ready` per write | Tool-calling protocol since v1.32-d |
| Tester    | Newly written files                  | Test files (vitest / jest based on project conventions)    | `TESTER_ENABLED=true` |
| Fixer     | Failed validation output             | Same tool-calling protocol as Coder; targeted retries      | Max 3 attempts |
| Reviewer  | Final diff                           | Pass / block (with reasons)                                | Lenient since v1.36 |

## RAG retrieval

`packages/rag/src/`:

- **`vector-store.ts`** — HNSW index, 768-dim vectors from `nomic-embed-text-v1.5`. Persists to `data/vectors/*.hnsw` + `*.json`.
- **`bm25.ts`** — pure-TS BM25 (k1=1.5, b=0.75). No external deps.
- **`graph-retriever.ts`** — query path: BM25 candidates ∪ dense candidates → RRF merge (k=60) → optional cross-encoder rerank → **2-hop expansion** (top-k symbols + 1-hop deps + reverse-dep callers) → monorepo meta injection → token-budgeted output.

`retrieveContextItems` retrieval layers (v1.43+):
1. **Dense + BM25 hybrid** → top-k symbols
2. **1-hop forward** (`getDependencies`) — symbols the top-k use
3. **2-hop reverse** (`getCallers`) — symbols that reference the top-k (usage context)
4. **Monorepo meta** (pinned) — tsconfig paths aliases + package exports, always appended so LLM generates correct workspace import paths

The code graph (`packages/code-graph/`) carries a **reverse index** (`reverseIndex: Map<name, Set<callerName>>`) maintained incrementally on `addFile`/`removeFile` and rebuilt on `loadFromDisk`. This enables `getCallers()` in O(1) per symbol.

**Monorepo meta** (`indexMonorepoMeta`): at the end of `indexCodebase`, parses `tsconfig.json compilerOptions.paths` and `packages/*/package.json exports`. Persisted to `graphsDir/monorepo-meta.json` for reload across restarts.

`buildRepoMap()` produces a token-budgeted summary used for Planner/Architect prompts.

## Edit safety

`packages/safe-exec/`:

| Component        | Role                                                                 |
|------------------|----------------------------------------------------------------------|
| `SafeWriter`     | Atomic write with rollback                                           |
| `BackupManager`  | Pre-write copy to `data/backups/`, prune at `BACKUP_MAX_AGE_DAYS`    |
| `DiffEngine`     | Computes unified diff for Reviewer / events                          |
| `edit-applier`   | Strict + tolerant strategies for `replace_in_file` (anchors and lines)|
| `prettier-runner`| Best-effort formatter pass before commit                             |
| `test-runner`    | Wraps vitest/jest, parses pass/fail per file                         |

`COMMIT_ONLY_IF_VALID=true` (default) blocks commits when validation hasn't converged. The work is preserved on the `auto/task-*` branch for human inspection.

## Cumulative mode

`CUMULATIVE_MODE=true` enables sequential task accumulation:

1. After a successful commit to `auto/task-<id>`, `GitEngine.mergeIntoCumulative()` fast-forward merges the branch into `auto/cumulative` (configurable via `CUMULATIVE_BRANCH`).
2. The next task forks from `auto/cumulative` instead of `defaultBranch` — it sees all prior commits.
3. On non-fast-forward conflict: emits `cumulative_merge_failed` event, branch is retained for manual resolution; the task itself is still `done`.
4. `JobWorker` is already sequential (single `processing` flag) — no race conditions between tasks.

Bench result: 6/6 sequential tasks committed on sandbox with zero manual merges (v1.45, 2026-05-15).

## SQLite symbol table (v1.67)

`packages/memory/src/symbol-table.ts` stores parsed symbols in per-project SQLite alongside the `MemoryStore`. Two tables:

- **`symbols`** — `(id, name, kind, file_path, start_line, end_line, body, package_name)` with a UNIQUE constraint on `(name, file_path)`.
- **`dependencies`** — `(from_id, to_id)` with cascade deletes. Bidirectional index on `to_id` for reverse callers.

`SymbolTable.getCallers(name)` runs a **recursive CTE** (`WITH RECURSIVE callers(id) AS (...)`) to traverse multi-hop caller chains in a single SQL query — O(depth × fan-out) without loading the full graph into memory. This complements the in-memory `code-graph` reverse index by persisting across restarts and scaling to large repos where the full graph doesn't fit in RAM.

The `@rag-system/memory` package exposes `SymbolTable` via `MemoryStore.symbolTable`.

## Qdrant vector backend (Phase 5)

Activated via `VECTOR_BACKEND=qdrant` (default `hnsw`). Requires a running Qdrant instance:

```bash
docker run -d --name qdrant -p 6333:6333 qdrant/qdrant
```

`QdrantVectorStore` (`packages/rag/src/qdrant-vector-store.ts`) implements the same interface as HNSW:
- Collection auto-created per project from `vectorsDir` slug (`anvil_<slug>`)
- SHA-1 UUID point ids (deterministic, valid UUID format)
- `payload.filePath` stored on every point for scope-filtered retrieval
- `save()`/`loadFromDisk()` are no-ops — Qdrant persists automatically
- On backend switch (HNSW → Qdrant): collection is empty but file hashes exist in SQLite → force full re-index triggered automatically

**Payload-filtered retrieval** (`v1.48`): `GraphRetriever.extractPackageScope(query)` extracts the first `packages/<pkg>` path from the task description. When found, the vector search is scoped to files under that package path — eliminates cross-package noise in dense monorepos like trpc (3938 symbols across 8 packages). HNSW users see no behavior change (filter silently ignored).

## Structural anchor v2 (v1.50)

`replace_method` and `replace_function` use AST-based lookups (`structural-edits.ts`) to find the target by name, then return an edit with absolute line coordinates so the writer doesn't have to do fragile text-matching. v2 fixes two real-world failures:

1. **Overload disambiguation:** TypeScript classes commonly have signature overloads above the implementation (e.g. `header(name: string): string; header(): Record<string,string>; header(name?: string) { ... }`). v1 took the first match — a signature without a body — corrupting the file. v2 prefers the implementation overload (the one with `body !== undefined`); when multiple bodies exist the optional `nearLine` parameter (1-based line hint from a prior `read_file`) picks the closest one.

2. **Property arrow function fallback:** Many real classes express methods as `name = (...) => { ... }` properties rather than `MethodDeclaration` syntax. v1 returned "not found"; v2 detects the `PropertyDeclaration` and returns a precise error: "spans lines X–Y, use `replace_in_file(file, X, Y, new_text)`". The Coder system prompt has explicit 3-step recovery guidance for this pattern.

L6 bench (large-file surgery, v1.50): 3/4 — overload disambiguation works on 489-line files; complex generics in 780-line files exceed model capability.

## Repo memory v2 — cross-project patterns (v1.69)

`MemoryStore.saveRepoPattern(projectId, issue)` stores Fixer-fixed validation errors in `repo_patterns` (per-project SQLite). Before each task, the Orchestrator injects them as a "learned constraints" block into the Planner/Coder prompt so recurring mistakes aren't repeated.

**v1.69 additions:**
- `issue_hash = sha256(normalize(issue))[0:16]` — content-based dedup key. A UNIQUE index on `issue_hash` means the same error is one row, not 50.
- `ON CONFLICT(issue_hash) DO UPDATE SET hit_count += 1` — frequency signal. `getRepoPatterns()` orders by `hit_count DESC`.
- `MemoryStore.getCrossProjectPatterns(currentProjectId, registryDbPath, dataRoot)` — opens all registered project DBs read-only, merges patterns by `issue_hash`, sums `hit_count` across projects. Patterns from other projects are labeled `(cross-project)` in the prompt.
- Format: `[×3] (cross-project) Cannot find module './X.js' — add .js extension` — frequency + origin in one line.

Note: `repo_patterns` schema migrates forward via `PRAGMA table_info` checks + `ALTER TABLE ADD COLUMN` — safe on existing DBs.

## Task cancellation (v1.49)

`POST /task/:id/cancel` marks the queued or running task as `cancelled` in `MemoryQueue`. `JobWorker` checks status before execution and passes a `shouldCancel: () => boolean` callback to `Orchestrator.runTask`. The orchestrator polls between step launches in `executePlanParallel` — running steps complete naturally (no mid-LLM interrupt), pending steps are skipped. SSE consumers receive a `cancelled` event.

## API surface

`packages/api/`:

| Method | Path                       | Purpose                                  |
|--------|----------------------------|------------------------------------------|
| GET    | `/health`                  | Server + backend liveness                |
| POST   | `/project`                 | Register a project (root → id)           |
| GET    | `/projects`                | List registered projects                 |
| POST   | `/index`                   | Index (or re-index) a project            |
| POST   | `/task`                    | Submit a task; returns `task_id`         |
| GET    | `/task/:id`                | Final task status                        |
| GET    | `/task/:id/stream`         | SSE stream of `TaskEvent` records        |
| POST   | `/task/:id/cancel`         | Cancel a queued or running task (v1.49)  |
| GET    | `/project/:id/healthcheck` | Pre-flight: verify tsc + tests on clean state (v1.52) |
| GET    | `/tasks`                   | List tasks (optionally filtered by project) |

The SSE event format is defined in `packages/shared/src/task-events.ts`. High-frequency events (`agent_stream`, `index_file`, `index_skip`) bypass the replay buffer; the rest are kept so late-joining SSE clients see context.

## Packages map

| Package             | Path                       | Responsibilities                         |
|---------------------|----------------------------|------------------------------------------|
| `@rag-system/shared`     | `packages/shared`     | Types, config, logger, task-event bus    |
| `@rag-system/model-router` | `packages/model-router` | LlamaSwap + Ollama clients; per-role alias routing |
| `@rag-system/memory`     | `packages/memory`     | SQLite store: tasks, ADRs, failures, embedding cache, projects, `SymbolTable` (v1.67), cross-project `repo_patterns` (v1.69) |
| `@rag-system/safe-exec`  | `packages/safe-exec`  | File writes, backups, diffs, edit-applier, prettier, test runner |
| `@rag-system/git-engine` | `packages/git-engine` | `simple-git` wrapper for branch + commit |
| `@rag-system/code-graph` | `packages/code-graph` | AST parser, code-graph, repo-map builder |
| `@rag-system/rag`        | `packages/rag`        | Vector store, BM25, hybrid retriever, file watcher |
| `@rag-system/agents`     | `packages/agents`     | Planner, Architect, Coder, Tester, Reviewer, Fixer, Orchestrator |
| `@rag-system/job-system` | `packages/job-system` | In-memory queue + worker loop            |
| `@rag-system/api`        | `packages/api`        | Fastify HTTP + SSE endpoints             |
| `@rag-system/mcp-server` | `packages/mcp-server` | MCP stdio transport (7 tools, 4 resources, 4 prompts) |
| `rag-system-vscode`      | `packages/vscode-extension` | VS Code sidebar, command palette, SSE consumer |

## How to add a new agent

Agents extend `BaseAgent` (`packages/agents/src/base-agent.ts`). The minimal contract:

1. Implement `async run(input): Promise<output>`.
2. Pull the model alias from `config.agents` (e.g. `LLM_SMALL_MODEL` for fast roles, `LLM_LARGE_MODEL` for code-producing).
3. Emit a `TaskEvent` of the appropriate `type` on each meaningful step (`step_start`, `step_complete`, `agent_stream` for token chunks).
4. Wire it into `Orchestrator.executeStep()` (sequential) or `executePlanParallel()` (DAG).
5. Add prompt files alongside the agent — see `coder.ts` and `task-agents/feature.ts` for the established style (system prompt + spec + conventions).

If the new agent needs structural edits, it should call the existing `structural-edits.ts` helpers (`add_method`, `add_route`, `add_import`, …) rather than re-implementing line-based logic.

## Design references

For the rationale behind specific decisions:

- [docs/designs/v1.32-c-sub-agents.md](designs/v1.32-c-sub-agents.md) — task-agents architecture
- [docs/designs/v1.32-d-llamacpp-backend.md](designs/v1.32-d-llamacpp-backend.md) — backend swap from Ollama to llama-swap
- [docs/designs/v1.33-reranker.md](designs/v1.33-reranker.md) — cross-encoder rerank
- [docs/designs/v1.34-hybrid-search.md](designs/v1.34-hybrid-search.md) — BM25 + dense via RRF
- [docs/designs/v1.35-coder-reviewer-fix.md](designs/v1.35-coder-reviewer-fix.md) — pre-Reviewer TS check, Gemma 4 as Coder
- [docs/designs/v1.37-l5x-comprehensive-bench.md](designs/v1.37-l5x-comprehensive-bench.md) — comprehensive benchmark methodology
- [docs/designs/v1.69-repo-memory-v2.md](designs/v1.69-repo-memory-v2.md) — cross-project patterns + content dedup + frequency ranking
