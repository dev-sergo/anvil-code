# Setup

End-to-end install guide for running the RAG System on your own machine.

## 1. Hardware

| Component | Minimum | Recommended |
|---|---|---|
| CPU | x86-64 or Apple Silicon | M2/M3 Pro or 12-core x86 |
| RAM | 16 GB | 32 GB |
| GPU VRAM | 16 GB (smaller models, lower success rate) | **24 GB** for Gemma 4 26B as Coder |
| Disk | 30 GB free (models + indices) | 60 GB |

The 24 GB VRAM target is what the published benchmarks are run on. On Macs, llama.cpp uses unified memory, so a 32 GB Mac Studio behaves like 24 GB VRAM + 8 GB system RAM. On NVIDIA, RTX 4090 / 3090 work; A5000 too.

## 2. LLM backend — llama-swap

[llama-swap](https://github.com/mostlygeek/llama-swap) is the recommended backend. It is a thin proxy on top of llama-server that auto-loads and unloads GGUF models in VRAM on demand. One endpoint fronts all your model aliases.

### 2a. Install llama.cpp and llama-swap

```bash
# llama.cpp — build from source
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp
make -j  # or: cmake -B build && cmake --build build -j

# llama-swap
go install github.com/mostlygeek/llama-swap/llama-swap@latest
```

Put the `llama-server` binary (from llama.cpp's `build/bin/` or root after `make`) on `PATH`, or use the absolute path in `config.yaml` below.

### 2b. Download GGUFs

Store them in `~/models/` (or anywhere; the path goes into `config.yaml`).

Recommended set (the benchmarks track this exact stack):

| File                                                         | Role       | Size  |
|--------------------------------------------------------------|------------|-------|
| `gemma-4-26b-a4b-it-mxfp4-MoE.gguf`                          | Coder      | ~14 GB |
| `qwen3-6-35B-A3B-instruct-Q4_K_M.gguf`                       | Planner/Reviewer | ~22 GB (3 B active) |
| `nomic-embed-text-v1.5.Q5_K_M.gguf`                          | Embeddings | ~110 MB |
| `bge-reranker-v2-m3-Q4_K_M.gguf` *(optional)*                | Reranker   | ~418 MB |

Smaller-budget alternative (16 GB VRAM):

| File                                                         | Role       |
|--------------------------------------------------------------|------------|
| `qwen2.5-coder-32b-instruct-Q4_K_M.gguf` *(or 14B-instruct)* | Coder      |
| `qwen2.5-7b-instruct-Q5_K_M.gguf`                            | Planner    |
| Same nomic-embed-text                                        | Embeddings |

### 2c. Configure llama-swap

`config.yaml` declares each profile and its alias. Example covering the recommended stack:

```yaml
models:
  gemma:
    cmd: |
      llama-server -m ~/models/gemma-4-26b-a4b-it-mxfp4-MoE.gguf
        -c 32768 --port 8081 --ngl 99 --flash-attn -ctk q8_0 -ctv q8_0 -t 0.7
    aliases: [gemma, long-context]

  qwen3:
    cmd: |
      llama-server -m ~/models/qwen3-6-35B-A3B-instruct-Q4_K_M.gguf
        -c 16384 --port 8082 --ngl 99 --flash-attn -ctk q8_0 -ctv q8_0 -t 0.7
    aliases: [qwen3, moe]

  embed:
    cmd: |
      llama-server -m ~/models/nomic-embed-text-v1.5.Q5_K_M.gguf
        -c 8192 --port 8083 --ngl 99 --embeddings
    aliases: [embed]

  reranker:
    cmd: |
      llama-server -m ~/models/bge-reranker-v2-m3-Q4_K_M.gguf
        -c 512 --port 8084 --ngl 99 --reranking
    aliases: [reranker]

listen: ":8080"
```

Adjust paths and the `-c` (context size) flag to fit your VRAM. llama-swap will auto-start each `llama-server` process on demand and shut down idle ones.

### 2d. Start the proxy

```bash
llama-swap --config config.yaml
```

Sanity check:

```bash
curl -s http://localhost:8080/v1/models | jq '.data[].id'
# → gemma, qwen3, embed, reranker

curl -s http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma","messages":[{"role":"user","content":"ping"}],"max_tokens":3}' | jq -r '.choices[0].message.content'
```

Full endpoint reference: [llama-api-reference.md](llama-api-reference.md).

## 3. RAG System

### 3a. Clone and build

```bash
git clone https://github.com/BubnovSA/anvil-code.git
cd anvil-code
npm install
npm run build
```

12 packages should compile cleanly. If `tree-sitter` native build fails on macOS, install Xcode CLT (`xcode-select --install`).

### 3b. Configure `.env`

```bash
cp .env.example .env
```

The example file is fully commented. The variables you almost always change:

```env
LLM_URL=http://localhost:8080        # llama-swap endpoint
LLM_LARGE_MODEL=gemma                # validated since v1.35 bench (7/8 on L2.x)
LLM_SMALL_MODEL=qwen3
LLM_EMBED_MODEL=embed
PROJECT_ROOT=/absolute/path/to/your/repo
```

If you tightened the context budget on llama-swap (e.g. running a 14 B model with `-c 8192`), drop `RAG_MAX_CONTEXT_TOKENS` to 1000–1500 so prompts still fit.

### 3c. Start the API server

```bash
npm run start
```

Server listens on `0.0.0.0:3000`. Verify:

```bash
curl http://localhost:3000/health
# {"status":"ok","backend":"llamacpp","backendUp":true,"uptime":42}
```

`backendUp: false` means the API can't reach `LLM_URL` — start llama-swap or fix `.env`.

### 3d. Register and index a project

```bash
# Register
curl -X POST http://localhost:3000/project \
  -H "Content-Type: application/json" \
  -d '{"root": "/absolute/path/to/your/repo"}' | jq

# Note the returned id, then index:
curl -X POST http://localhost:3000/index \
  -H "Content-Type: application/json" \
  -d '{"project": "<project_id>"}'

# Watch indexing progress (SSE)
curl -N http://localhost:3000/task/<index_id>/stream
```

Indexing the codebase populates the HNSW vector store and the AST graph at `data/vectors/` and `data/graphs/`. Both are flat JSON files; safe to delete and re-index if anything looks off.

### 3e. Submit a task

```bash
curl -X POST http://localhost:3000/task \
  -H "Content-Type: application/json" \
  -d '{"task": "Add a request-id middleware to the Fastify server", "project": "<project_id>", "mode": "balanced"}'
```

`mode`:

| Value      | Effect                                                   |
|------------|----------------------------------------------------------|
| `fast`     | Skip Tester, single Fixer attempt, shorter retrieval     |
| `balanced` | Default — Tester on, Fixer ×3, full retrieval            |
| `deep`     | Bigger retrieval window, extra Architect pass            |

Stream events:

```bash
curl -N http://localhost:3000/task/<task_id>/stream
```

You'll see the structured event sequence: `queued → running → plan → step_start → coder_file_ready → validation_start → validation_pass → commit → done`.

## 4. VS Code extension (optional but recommended)

```bash
cd packages/vscode-extension
npm run package   # produces rag-system-vscode-*.vsix
```

In VS Code: **Extensions → ⋯ → Install from VSIX…** and pick the `.vsix`.

After install:

1. Open the **RAG System** sidebar (rocket icon in Activity Bar).
2. **RAG System: Set API URL** → enter `http://localhost:3000` if not already.
3. **RAG System: Register Project** → pick the current workspace folder.
4. **RAG System: Submit Task** → pick mode, type the task, watch the stream in the **RAG System** output channel.

The status bar shows the active project; while a task is running, a second item shows the current phase (queued / running / planning / step / validate / committed).

## 5. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `backendUp: false` | llama-swap not running or `LLM_URL` wrong | `curl $LLM_URL/v1/models` to verify |
| `exceed_context_size` errors | Task too large for model ctx | Lower `RAG_MAX_CONTEXT_TOKENS`, or use a 32 K model (`gemma`) |
| Indexing hangs at 0 % | Embedding model not loaded | `curl $LLM_URL/v1/embeddings` should return 200 |
| `validation_fail` on first task in a real repo | Pre-existing failing tests | Baseline detection runs on first task — re-submit |
| `auto/task-*` branches piling up | Successful and failed tasks both create branches | `git branch \| grep auto/ \| xargs git branch -D` to clean |
| VS Code extension says "no projects" | API URL not reachable from VS Code | **RAG System: Set API URL** to confirm; check firewall |
| Model unload mid-task | llama-swap idle timer kicked in | Increase `idle_timeout` in `config.yaml` (default 5 min) |
