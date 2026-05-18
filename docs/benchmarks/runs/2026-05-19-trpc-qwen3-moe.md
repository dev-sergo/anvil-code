# Run 2026-05-19 — tRPC bench with Qwen3-35B MoE (v1.63)

## Configuration

| | |
|---|---|
| Date | 2026-05-19 |
| rag-system revision | `c0cfa5e` (v1.63) |
| LLM_LARGE_MODEL | `qwen3-32k` (Qwen3-35B-A3B MoE, 32K ctx, q4_0 KV, thinking mode) |
| LLM_SMALL_MODEL | `qwen3-32k` |
| LLM_EMBED_MODEL | `embed` (nomic-embed-text) |
| Speed | **11 tok/s** |
| GPU | RTX 3090 24GB |
| Baseline | v1.47 (2026-05-15): trpc 3/6 (50%), v1.43 peak: trpc 5/6 (83%) |
| Cumulative? | no (each task on clean main) |
| trpc rev | `23c723c` (v11.17.0) |

---

## tRPC Results (T1–T6)

| # | Task | Result | Time | v1.47 |
|---|------|--------|------|-------|
| T1 | JSDoc TRPCError | ✅ commit (1 file) | ~4min | ✅ |
| T2 | getHTTPStatusCode helper | ❌ ts_fail (TS2307 bad import) | ~3min | ❌ ts_fail |
| T3 | onError callback in standalone | ❌ vitest crash | ~6min | ✅ |
| T4 | createTimeout AbortSignal helper | ✅ commit (1 file) | ~2min | ✅ |
| T5 | maxBodySize in nodeHTTPRequestHandler | ❌ test_fail (hardcoded 100KB) | ~6min | ❌ reviewer_reject |
| T6 | dataLoader retry option | ❌ noop | ~1min | ❌ noop |

**tRPC Qwen3 MoE: 2/6 (33%)** — хуже чем v1.47 (3/6) и сильно хуже v1.43 peak (5/6).

---

## Analysis

### T1 ✅ — JSDoc TRPCError

Правильные изменения: 20 строк JSDoc, class-level + constructor + `code` property. Качество выше чем у Gemma — более подробные `@param opts.message`, `@param opts.cause` аннотации.

**Проблема обнаруженная при T1 (первая попытка)**: Vitest globalSetup в `packages/openapi` запускает codegen, который инвалидирует кэш при изменении `server/src/**`. Старый кэш (Gemma-прогон) → hash mismatch → codegen запустился → broken imports → tests failed.

**Fix**: `cd packages/openapi && pnpm codegen` перед bench (7 секунд). Обновляет кэш с clean-state хэшами. Вторая попытка T1 → ✅.

### T2 ❌ — getHTTPStatusCode helper

ts_fail (TS2307): Coder создал файл с некорректным import path (`../../unstable-core-do-not-import/http/getHTTPStatusCode.js`). Стабильный failure pattern в trpc monorepo — workspace package resolution сложная. В v1.43 проходило — модельная дисперсия.

### T3 ❌ — onError callback in standalone

vitest internal crash (`chunks/index.CyBMJtT7.js:556:9`). Coder сделал инвазивный рефакторинг:
- Изменил `StandaloneHandlerOptions` тип с generic triplet на single generic
- Добавил импорты `resolveResponse`, `BaseHandlerOptions`, `HTTPErrorHandler`
- Сломал existing callers через type mismatch

Qwen3 thinking mode иногда приводит к "умным" рефакторингам когда нужно минимальное изменение.

### T4 ✅ — createTimeout AbortSignal helper

Новый файл `packages/server/src/internals/timeout.ts`, 5 строк. Чистая реализация `AbortController` + `setTimeout`. Проходит validation за 2 минуты.

### T5 ❌ — maxBodySize in nodeHTTPRequestHandler

test_fail: Coder захардкодил 100KB (`const limit = 100 * 1024`) вместо добавления configurable опции. Изменил `opts.maxBodySize ?? null` на `limit` — сломал существующую опцию. Существующие тесты (регрессионные) поймали это.

### T6 ❌ — dataLoader retry option

noop (оба attempt → 0 изменений). dataLoader.ts 900+ строк. Coder прочитал файл, решил что retry уже реализован или задача уже выполнена. v1.63 `read_file start_line` не помог — проблема в том что модель решает не делать изменений, а не в навигации по файлу.

В v1.39 и v1.41 T6 проходил. Модельная дисперсия — с Qwen3 thinking mode модель могла найти какой-то похожий pattern в 900-строчном файле и решить что retry уже есть.

---

## OpenAPI codegen cache issue — KEY FINDING

**Проблема**: `packages/openapi/test/scripts/codegen.ts` — vitest globalSetup. Запускает codegen для всех роутеров при изменении любого файла в `packages/server/src/**`. Кэш в `test/.cache/codegen.json` НЕ отслеживается git (в .gitignore).

**Механизм**:
1. Предыдущий bench (v1.47, Gemma) → codegen кэш с Gemma-modified TRPCError.ts хэшами
2. Cleanup: `git reset --hard` — TRPCError.ts обратно к original, кэш НЕ сбрасывается
3. Следующий bench: любая задача меняет `server/src/**` → hash mismatch → codegen запускается
4. Codegen версия 0.94.5 → если запускается в виtest environment с stale context → partial output (нет `client/` subdir) → broken TS imports → test fail

**Fix**: `cd /Users/admin/Documents/work/trpc/packages/openapi && pnpm codegen` перед bench.
Занимает ~7 секунд, обновляет кэш с clean-state хэшами. Codegen в vitest среде всегда кэш-мисс (т.к. задача изменила server/src/**) но виtest generation работает корректно.

---

## Unit Tests (rag-system)

| | |
|---|---|
| Tests | 602/605 passed |
| Failures | 3 pre-existing ASTParser (Python/Rust/Go) |
| Status | ✅ no regression |

---

## Comparison with previous trpc runs

| Version | Model | tRPC | Notes |
|---------|-------|------|-------|
| v1.38 | Gemma-26B | 2/6 (33%) | baseline |
| v1.42 | Gemma-26B | 4/6 (67%) | monorepo meta fix |
| v1.43 | Gemma-26B | **5/6 (83%)** | peak result |
| v1.46 | Gemma-26B | 2/6 (33%) | RAG_GRAPH_HOPS=3 regression |
| v1.47 | Gemma-26B | 3/6 (50%) | regression reverted |
| **v1.63** | **Qwen3-35B MoE** | **2/6 (33%)** | openapi cache issue + model variance |

---

## Root cause of Qwen3 MoE underperformance on trpc

1. **T3 regression**: Qwen3 thinking mode производит "умные" рефакторинги. Для T3 (onError в standalone) вместо минимального добавления опции Qwen3 переделал type signatures. Gemma добавляла минимальное изменение.

2. **T6 persistent noop**: dataLoader.ts 900+ строк. Qwen3 с thinking mode, прочитав файл, мог решить что retry логика уже имплементирована (похожие структуры есть). Gemma просто писала новый код. read_file start_line (v1.63) помогает НАВИГАЦИИ но не меняет решение "нужно ли делать изменения".

3. **Openapi cache bug**: Не проблема Qwen3 — это инфраструктурная проблема. Требует `pnpm codegen` перед каждым trpc bench.

---

## Next steps

- T6 dataLoader retry: попробовать более конкретный промпт (указать конкретную строку DataLoaderOptions типа + пример fetchWithRetry функции)
- T3 onError: более restrictive промпт — "only add onError option to existing options type, do not refactor existing types"
- T5 maxBodySize: использовать существующий `opts.maxBodySize` в промпте — "add maxBodySize to the existing NodeHTTPHandlerOptions, default 100KB"
- Openapi cache: добавить `pnpm codegen` в bench setup checklist
