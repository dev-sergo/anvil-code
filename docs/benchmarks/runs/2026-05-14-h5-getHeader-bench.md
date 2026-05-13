# Run 2026-05-14 — H5 getHeader hono (task reformulation)

## Context

H5 was first run in v1.38 bench as `no_op` (Coder 0 changes). In v1.41 bench it
became `reviewer_reject` after noop retry was added — Coder produced files but
Reviewer correctly rejected: "Missing export from `packages/hono/src/utils/index.ts`".

Diagnosis: original task description referenced `packages/hono/src/utils/index.ts`
which does not exist in the hono monorepo (there's only `src/utils/`). Coder wrote
`getHeader` to `src/utils/headers.ts` but couldn't add the barrel export because
the path in the task was wrong, so Fixer also failed. Reviewer was correct.

**Fix:** reformulate the task to match real hono structure — add `getHeader` to
`src/utils/headers.ts` directly, no barrel needed.

## Task (corrected)

```
Add a getHeader helper function to src/utils/headers.ts in the hono repository.
The function signature: getHeader(c: Context, name: string): string | undefined.
It should delegate to c.req.header(name). Import Context as a type from
../context.js at the top of the file. Export the function from src/utils/headers.ts
— no separate barrel file needed.
```

**Project:** honojs/hono — 366 TS files, ID `9c7b84a5ef96`

## Results

| Run | Result | Time | Notes |
|-----|--------|------|-------|
| r1 | ✅ commit | 71s | 2 files: `src/utils/headers.ts` (+5 lines), `src/utils/__tests__/headers.test.ts`. |
| r2 | ✅ commit | 64s | Same pattern, stable. |

**H5: 2/2** ✅

## r1 implementation

```typescript
// src/utils/headers.ts (appended)
import type { Context } from '../context.js'

export function getHeader(c: Context, name: string): string | undefined {
  return c.req.header(name)
}
```

Correct: type import, delegates to existing `c.req.header()`, validation_pass.

## History

| Version | Result | Pattern |
|---------|--------|---------|
| v1.38 | ❌ | `no_op` — Coder 0 changes |
| v1.39–v1.40 | ❌ | `no_op` — same |
| v1.41 | ❌ | `reviewer_reject` — noop retry worked, wrong barrel path |
| v1.41 + task fix | ✅ 2/2 | Correct task → correct implementation |
