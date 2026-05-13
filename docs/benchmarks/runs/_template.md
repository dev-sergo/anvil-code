# Run YYYY-MM-DD — &lt;tag&gt;

## Configuration

| | |
|---|---|
| Date | YYYY-MM-DD |
| rag-system revision | `git rev-parse --short HEAD` |
| Iteration tag | v1.X (what this run tests) |
| LLM_BACKEND | llamacpp / ollama |
| LLM_URL | `http://localhost:8080` (llamacpp) / `http://localhost:11434` (ollama) |
| LLM_LARGE_MODEL | `qwen-coder-long` / `coder` / `qwen-coder` / ... |
| LLM_SMALL_MODEL | `qwen3` / `qwen` / ... |
| EMBED_BACKEND | llamacpp / ollama (default = LLM_BACKEND) |
| EMBED_MODEL | `embed` (nomic-embed-text-v1.5, 768 dim) |
| TOOL_CALLING_CODER | true / false |
| TESTER_ENABLED | true / false |
| PLANNER_MAX_STEPS | N |
| Other ENV diffs from default | ... |
| Sandbox / target | `/path/to/sandbox` / `/path/to/target` / другое |
| Cumulative? | no (each task on clean main) / yes (chained) |

## Tasks

### L1.1 — &lt;short title&gt;

| | |
|---|---|
| Plan size | N step(s) |
| Files touched | path/a, path/b |
| Tool calls (Coder) | N |
| Tool calls (Fixer) | N |
| Validation | pass / fail / skipped |
| Commit | yes / commit_skipped / commit_partial |
| Wall time | Nm Ns |

**Diff highlights:**
```diff
+ ...
```

**Issues / observations:**
- ...

**Score:**
| Correctness | Architecture | Style | Completeness | Idiomatic | **Avg** |
|---|---|---|---|---|---|
| N/10 | N/10 | N/10 | N/10 | N/10 | **N/10** |

---

(repeat for each task)

## Aggregate

| | |
|---|---|
| Tasks attempted | N |
| Green commits | N |
| Validation pass rate | N/N |
| Pathology bails (Coder) | N |
| Pathology bails (Fixer) | N |
| Run score (avg) | N/10 |

## What worked

- ...

## What broke

- ...

## Lessons / next iteration ideas

- ...
