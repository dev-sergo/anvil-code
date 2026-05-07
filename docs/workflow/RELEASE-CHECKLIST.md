# Release checklist — public GitHub OpenSource

**Target:** 2026-05-16
**Current readiness:** 55%

---

## Quality gates

- [x] v1.34 Hybrid search — BM25+RRF реализован и протестирован
- [x] L4.1 Fixer regression — interceptToolCall блокирует create_file на test paths
- [x] 530/530 unit tests green
- [x] `data/backups/**` excluded from indexing
- [x] Qwen3 thinking mode fix (chat_template_kwargs)
- [ ] L2.x smoke bench на sandbox с v1.34 (2–3 задачи, понять картину)
- [ ] L4.1 Fixer 2/3 → 3/3: micro-fix промпта (тип без значения)

## GitHub repo

- [ ] README.md — user-facing: что это, quickstart, архитектура, скриншот/GIF
- [ ] LICENSE (MIT)
- [ ] CONTRIBUTING.md
- [ ] .env.example актуален (все переменные документированы)
- [ ] .gitignore: *.gguf, models/, data/backups/, dist/, node_modules/
- [ ] GitHub repo visibility → public

## VS Code extension

- [ ] Extension builds clean (`npm run build` в packages/vscode-extension)
- [ ] .vsix packaged (`vsce package`)
- [ ] Smoke test: install from .vsix, connect to llama-swap, run a task
- [ ] README в packages/vscode-extension (install + connect)

## Documentation

- [ ] Quickstart в README: llama-swap → API → extension → first task
- [ ] Known limitations секция в README (cumulative state, 24GB VRAM cap, TesterAgent)
- [ ] docs/llama-api-reference.md актуален

## Pre-release sync

- [x] CHANGELOG.md: v1.34 запись добавлена
- [x] ROADMAP.md актуален (v1.35 помечена post-release)
- [ ] git tag v1.34 на dev перед мержем в main
- [ ] dev → main merge

---

## Out of scope for v1.0 (post-release)

- v1.35 multi-hop transitive closure
- Phase 5: Qdrant, SQLite symbol table
- Task cancellation POST /task/:id/cancel
- TesterAgent vitest/jest mock fix
