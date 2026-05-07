# Benchmark targets

## Sandbox — L1/L4 (unit tasks)

**Path:** `/Users/admin/Documents/work/rag-system-sandbox`
**Purpose:** L1.x (feature add), L4.x (bugfix) tasks на простом Express проекте
**Structure:** src/server.ts, src/routes/users.ts, src/services/user-service.ts, tests/users.test.ts
**Git tags:**
- `24ce9fa` — clean main (baseline для L1.x)
- `bench-l41-baseline` (e1793e8) — injected bug: `createdAt` не установлен в UserService.create()

**Reset between runs:**
```bash
cd /Users/admin/Documents/work/rag-system-sandbox
git checkout main && git reset --hard 24ce9fa
# для L4.1:
git checkout bench-l41-baseline
# затем re-index через API
```

**Tasks:**
- L1.1 — Add GET /health endpoint
- L1.2 — Add Zod validation to POST /users
- L1.3 — Add GET /users/:id/stats with computed accountAge
- L4.1 — Fix missing createdAt in UserService.create()

---

## Target — L2.x (cross-file, 91-file codebase)

**Path:** `/Users/admin/Documents/work/rag-system-target`
**Purpose:** Precision@5 benchmark — retrieval quality на реальной большой кодовой базе
**Size:** 91 файл TS, 6717 LOC
**Codebase:** rag-system source (наш собственный, dogfooding)

**Tasks:**
- L2.1 — Add request-logging middleware in src/middleware/request-log.ts, register in src/server.ts
  **Metric:** retrieval@5 contains `packages/api/src/server.ts`
- L2.2 — Extract Zod schema for POST /users into src/schemas/user-schema.ts
  **Metric:** retrieval@5 contains route/schema files

**Notes:**
- L2.1/L2.2 написаны под sandbox paths (src/server.ts, src/routes/users.ts) — для target нужны L2.x-target variants
- data/backups/** попадает в индекс (шум) — v1.34 исключит

---

## Strategy: dogfooding для OpenSource release

Для публичного README benchmark используем **rag-system сам на себе** (target codebase).

**Нарратив:** "We built this tool while using it to develop itself"

**Публичный benchmark набор (планируется):**
- Feature: добавить новый agent type
- Bugfix: фикс race condition в orchestrator
- Refactor: экстракт helper из tool-calling-coder
