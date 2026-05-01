# llama-swap API — MacBook Reference

Server: `http://172.20.10.4:8080`

---

## Now available models

| Full ID | Aliases | Notes |
|---|---|---|
| `qwen2-5-coder-32b-instruct-q4-k-m-ctx-8k-q8-0-kv-t02` | `qwen-coder`, `coder` | Code/JSON, 8K, ~25-35 t/s |
| `qwen2-5-coder-32b-instruct-q4-k-m-ctx-16k-q8-0-kv-t02` | `qwen-coder-long` | Code, 16K refactors |
| `qwen2-5-32b-instruct-q4-k-m-ctx-8k-q8-0-kv-t07` | `qwen`, `qwen-32b` | Blog/chat, balanced |
| `qwen2-5-32b-instruct-q4-k-m-ctx-8k-q8-0-kv-t09` | `qwen-creative` | Brainstorm, t=0.9 |
| `deepseek-coder-33b-instruct-q4-k-m-ctx-16k-q8-0-kv-t02` | `deepseek` | Alt code, 16K |
| `gemma-4-26b-a4b-it-mxfp4-moe-ctx-32k-q8-0-kv-t07` | `gemma`, `long-context` | Long context 32K, fast MoE |
| `qwen3-6-35b-a3b-ud-q4-k-m-ctx-16k-q8-0-kv-t07` | `qwen3`, `moe` | Fastest MoE (3B active) |
| `meta-llama-3-1-70b-instruct-q4-k-m-ctx-4k-q4-0-kv-t07` | `llama70` | Best quality, ~3-5 t/s |

> Aliases работают только если объявлены в config.yaml. Полные имена работают всегда.

---

## Setup once on MacBook

Already use this env

```bash
export LLM="http://172.20.10.4:8080"
```

---

## Inspection

```bash
# Health
curl -s $LLM/health

# All available models
curl -s $LLM/v1/models | jq -r '.data[].id'

# What's loaded in VRAM right now
curl -s $LLM/running | jq

# Token usage / latency metrics
curl -s $LLM/api/metrics | jq
```

---

## Chat completion — all variants

### Minimal

```bash
curl -s $LLM/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "qwen",
  "messages": [{"role":"user","content":"Hello"}]
}' | jq -r '.choices[0].message.content'
```

### With system prompt + sampling params

```bash
curl -s $LLM/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "qwen",
  "messages": [
    {"role":"system","content":"You are concise."},
    {"role":"user","content":"Explain quicksort in 3 sentences."}
  ],
  "temperature": 0.7,
  "top_p": 0.9,
  "top_k": 40,
  "min_p": 0.05,
  "max_tokens": 500,
  "repeat_penalty": 1.05,
  "seed": 42,
  "stop": ["\n\n"]
}'
```

### Streaming (SSE)

```bash
curl -N $LLM/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "qwen",
  "stream": true,
  "messages": [{"role":"user","content":"Tell me a 3-paragraph story."}]
}'
```

### JSON mode (structured output)

```bash
curl -s $LLM/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "coder",
  "messages": [{"role":"user","content":"Return a person object with name=Alice age=30 as JSON"}],
  "response_format": {"type":"json_object"},
  "temperature": 0.2
}' | jq -r '.choices[0].message.content'
```

### Tool calling (function calling)

```bash
curl -s $LLM/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "coder",
  "messages": [{"role":"user","content":"What is the weather in Bangkok?"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get current weather for a city",
      "parameters": {
        "type": "object",
        "properties": {"city":{"type":"string"}},
        "required": ["city"]
      }
    }
  }]
}' | jq '.choices[0].message.tool_calls'
```

### Multi-turn conversation

```bash
curl -s $LLM/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "qwen",
  "messages": [
    {"role":"user","content":"Capital of Thailand?"},
    {"role":"assistant","content":"Bangkok."},
    {"role":"user","content":"Population?"}
  ]
}' | jq -r '.choices[0].message.content'
```

### Benchmark (tokens/sec)

```bash
curl -s $LLM/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "qwen",
  "stream": false,
  "messages": [{"role":"user","content":"Write 50 words about Bangkok rainy season."}]
}' | jq '{model, usage, t_per_s: .timings.predicted_per_second}'
```

### Legacy completion (no chat format)

```bash
curl -s $LLM/v1/completions -H "Content-Type: application/json" -d '{
  "model": "qwen",
  "prompt": "Once upon a time",
  "max_tokens": 50
}'
```

---

## Model management

```bash
# Unload ALL models (free VRAM now)
curl -s -X POST $LLM/api/models/unload

# Unload specific model (use full ID)
curl -s -X POST $LLM/api/models/unload/qwen2-5-32b-instruct-q4-k-m-ctx-8k-q8-0-kv-t07

# Preload / warm up (avoids cold-start on first real request)
curl -s $LLM/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"qwen","messages":[{"role":"user","content":"ok"}],"max_tokens":1}' >/dev/null

# Upstream introspection (debug)
curl -s $LLM/upstream/qwen/props | jq          # model metadata
curl -s $LLM/upstream/qwen/slots | jq          # parallel slot state
curl -s $LLM/upstream/qwen/tokenize \
  -H "Content-Type: application/json" -d '{"content":"Hello world"}' | jq
```

---

## Logs

```bash
# Buffered last ~10 KB
curl -s $LLM/logs

# Live stream (Ctrl+C to exit)
curl -N $LLM/logs/stream                       # everything
curl -N $LLM/logs/stream/proxy                 # only llama-swap proxy
curl -N $LLM/logs/stream/upstream              # only llama-server processes
curl -N $LLM/logs/stream/qwen                  # only one model (alias works)
curl -N "$LLM/logs/stream?no-history"          # only new lines

# Filtered
curl -N $LLM/logs/stream | grep -iE "error|eval time"

# SSE events: model loads/unloads, request lifecycle
curl -N $LLM/api/events
```


## Common runtime params (in request body)

| Param | Range | Use |
|---|---|---|
| `temperature` | 0.0-2.0 | 0.2 code, 0.7 chat, 0.9 creative |
| `top_p` | 0.0-1.0 | 0.9 default |
| `top_k` | int, -1=off | 40 typical |
| `min_p` | 0.0-1.0 | 0.05 typical |
| `max_tokens` | int | output limit |
| `repeat_penalty` | float | 1.0=off, 1.1 mild |
| `presence_penalty` | -2.0-2.0 | OpenAI-style |
| `frequency_penalty` | -2.0-2.0 | OpenAI-style |
| `seed` | int | reproducibility |
| `stop` | array | stop strings |
| `stream` | bool | SSE streaming |
| `response_format` | `{"type":"json_object"}` | force JSON |
| `tools` | array | function calling |

> Не runtime (требует профиль в config.yaml): `ctx-size`, `cache-type`, `ngl`, `flash-attn`.

---

## Quick troubleshooting

```bash
# Server up?
curl -s $LLM/health

# Model exists?
curl -s $LLM/v1/models | jq -r '.data[].id' | grep qwen

# Why is it slow? Watch live
curl -N $LLM/logs/stream | grep "eval time"

# OOM / hung? Force-unload everything
curl -s -X POST $LLM/api/models/unload

# Service crashed?
ssh serbio@172.20.10.4 sudo systemctl restart llama-swap
```
