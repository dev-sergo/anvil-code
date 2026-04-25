# RAG System — VSCode Extension

GUI sidebar for the local RAG system: switch projects, fire tasks, watch
agents stream output in real time.

## Features

- **Projects** sidebar — list of registered projects, click to set active
- **Tasks** sidebar — recent tasks per project, status icons (queued / running / completed / failed)
- **Status bar** — shows the active project; click to switch
- **Run Task** command — quick prompt + mode picker, posts to `/task`, auto-opens the live stream
- **Index Active Project** command — triggers `POST /index`, streams progress events
- **Live SSE stream** — task progress (plan, step start/done, agent tokens, file ready, validation, commit, done) prints to the *RAG System* output channel

## Loading in development

```bash
# from the monorepo root
npm install
npx turbo run build --filter=rag-system-vscode
```

In VSCode: **Run → Start Debugging** (with `packages/vscode-extension` as the
workspace folder) opens an Extension Development Host with this extension
loaded. The activity bar gets a 🚀 icon — click it to open the sidebar.

Configure the API URL via `RAG: Set API URL` (default `http://localhost:3000`).

## Packaging a `.vsix`

```bash
npm install -g @vscode/vsce
cd packages/vscode-extension
vsce package --no-dependencies
```

Produces `rag-system-vscode-0.1.0.vsix` you can install via
**Extensions → … → Install from VSIX**.
