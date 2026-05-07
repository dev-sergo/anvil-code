# Release checklist — public GitHub OpenSource

Target: 2026-05-16

## Quality gates

- [ ] v1.34 Hybrid search — precision@5 > 0% on rag-system-target
- [ ] L4.1 Fixer regression fixed — 3/3 (currently 1/3)
- [ ] 507+/507 unit tests green
- [ ] `data/backups/**` excluded from indexing

## Dogfood benchmark

- [ ] Bench on rag-system-target: L1.1, L1.2, L1.3 ≥ 2/3 each
- [ ] Bench on rag-system-target: L4.1 ≥ 3/3
- [ ] Bench on rag-system-target: L2.1/L2.2 precision@5 > 0% (v1.34 goal)

## GitHub repo

- [ ] README.md — setup instructions, architecture overview, quick start
- [ ] LICENSE (MIT)
- [ ] CONTRIBUTING.md
- [ ] .env.example with all env vars documented
- [ ] .gitignore covers *.gguf, models/, data/backups/, dist/, node_modules/
- [ ] GitHub repo visibility set to public

## VS Code extension

- [ ] Extension builds clean (`npm run build` в packages/vscode-extension)
- [ ] .vsix packaged (`vsce package`)
- [ ] Smoke test: install from .vsix, connect to llama-swap, run a task
- [ ] README в packages/vscode-extension с инструкцией установки

## Known limitations documented

- [ ] KNOWN-LIMITATIONS.md или секция в README: cumulative state regression, 24GB VRAM cap, TesterAgent vitest/jest mismatch
- [ ] ROADMAP.md актуален

## Setup / reproducibility

- [ ] Инструкция запуска API сервера в README
- [ ] Инструкция настройки llama-swap (ссылка на docs/llama-api-reference.md)
- [ ] Sandbox setup скрипт или инструкция для воспроизведения bench
