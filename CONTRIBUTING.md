# Contributing

## Prerequisites

- Node.js 18 LTS or later
- npm 9+
- A running LLM backend (see README quickstart)

## Setup

```bash
git clone https://github.com/BubnovSA/anvil-code.git
cd anvil-code
npm install
npm run build
```

## Running tests

```bash
npm test          # all 12 packages, ~530 unit tests
```

Tests are pure unit tests — no LLM backend required.

## Project structure

12 TypeScript packages under `packages/`. Each has its own `tsconfig.json` and test suite (Vitest). Turborepo handles build ordering.

| Package | Role |
|---|---|
| `shared` | Types, logger, utilities |
| `model-router` | LLM client + role-to-model routing |
| `rag` | BM25 + HNSW hybrid retrieval, GraphRetriever |
| `code-graph` | AST parser, dependency graph |
| `agents` | All task agents + Orchestrator |
| `safe-exec` | Backup, diff, safe file writes |
| `git-engine` | Branch + commit management |
| `memory` | SQLite task/ADR/failure store |
| `job-system` | In-memory queue + Worker |
| `api` | Fastify HTTP server |
| `mcp-server` | MCP protocol adapter |
| `vscode-extension` | VS Code sidebar extension |

## Making changes

1. Create a branch: `git checkout -b your-feature`
2. Make changes and add tests for new behavior
3. Run `npm test` — all tests must pass
4. Submit a pull request against `main`

## Benchmarks

The `docs/benchmarks/` directory contains task-level regression benchmarks (L1–L4). Before submitting changes that affect agent behavior, run the relevant bench level against the sandbox and include results in your PR description.

Bench setup: `docs/benchmarks/tasks.md`  
Sandbox: a minimal 5-file TypeScript repo — see `docs/benchmarks/runs/` for examples.

## Code style

- TypeScript strict mode throughout
- No `any` except at integration boundaries
- No comments unless the why is non-obvious
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, etc.)
