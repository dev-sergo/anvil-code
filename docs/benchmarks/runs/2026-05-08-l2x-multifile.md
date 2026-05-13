# Run 2026-05-08 — L2.x multi-file benchmark (8 задач)

## Configuration

| | |
|---|---|
| Date | 2026-05-08 |
| rag-system revision | `8fb56d6` |
| Iteration tag | v1.34.1 (post-BM25 hybrid search) |
| LLM_BACKEND | llamacpp |
| LLM_URL | `http://localhost:8080` |
| LLM_LARGE_MODEL | `qwen-coder-long` |
| LLM_SMALL_MODEL | `qwen3` |
| TOOL_CALLING_CODER | true |
| TESTER_ENABLED | false |
| Mode | balanced |
| Sandbox | `~/rag-system-sandbox` (Fastify+Zod+Vitest users API, ~6 файлов) |
| Cumulative? | no — каждая задача на чистом main |

**Цель:** ответить на главный открытый вопрос — работает ли система на multi-file задачах (2–5 файлов). Предыдущие L2.1/L2.2 на v1.33 дали 0/3; v1.34 добавил BM25, может изменить картину.

**Критерий:** успех = git commit с правильным кодом без ручного вмешательства.

## Tasks summary

| # | Задача | Status | Wall | Commit | Code OK | Verdict |
|---|---|---|---|---|---|---|
| L2.1 | age field (3 файла) | failed | 151s | — | — | ❌ failed |
| L2.2 | DELETE /users/:id (2 файла) | completed | 161s | нет | нет (битый синтаксис) | ⚠️ false-positive |
| L2.3 | pagination (2 файла) | failed | 161s | — | — | ❌ failed |
| L2.4 | rename create→register (3 файла) | completed | 60s | нет | n/a (0 changes) | ⚠️ no-op |
| L2.5 | updatedAt + PATCH (3 файла) | completed | 438s | нет | нет (битый синтаксис) | ⚠️ false-positive |
| L2.6 | email уникальность 409 (2 файла) | completed | 146s | нет | n/a (0 changes) | ⚠️ no-op |
| L2.7 | GET /users?email= (2 файла) | completed | 121s | **нет** | **да** | ⚠️ код ок, commit отсутствует |
| L2.8 | logging middleware (1 новый + 1 mod) | failed | 116s | — | — | ❌ failed |

**Wall total:** ~22 минуты на 8 задач (~2.7 мин/задача).

## Detailed observations

### L2.1 — age field ❌
Plan = 1 step. Stream показал: Coder произвёл `src/types.ts`, затем Fixer прошёлся по 3 файлам (types, user-service, routes). Завершилось `failed`. Вероятно Reviewer 3× rejected либо validation не прошла.

### L2.2 — DELETE ⚠️ false-positive
Status=completed, **но**:
- Коммита нет (git log не сдвинулся)
- На auto/-ветке остались staged изменения, но **код сломан**: метод `delete` врезан внутрь `create` без правильной структуры:
```
  create(input: ...): User {
    ...
    return user;
-  },
+  delete(id: string): boolean {
+    return users.delete(id);
+  }
+}
};
```
- Route `users.ts` корректный.
- Reviewer/build-check эту синтаксическую кашу пропустил.

### L2.3 — pagination ❌
Provavl как L2.1.

### L2.4 — rename ⚠️ no-op
Status=completed за 60s, **0 изменений в файлах**. Plan видимо вернул 0 шагов (либо retrieval решил что переименование уже сделано). Самый быстрый "успех", но фактически no-op.

### L2.5 — updatedAt ⚠️ false-positive (самый долгий: 438s)
Status=completed, **но**:
- Коммита нет
- `routes/users.ts`: PATCH добавлен корректно ✓
- `types.ts`: `updatedAt` добавлен корректно ✓
- `user-service.ts`: **`update` метод врезан вместо `create`** — потеряно `const user: User =`, осталась внутренность от create:
```
-  create(input: ...): User {
-    const user: User = {
+  update(id: string, input: ...): User | null {
       id: randomUUID(),
       ...
```
- Файл не компилируется. `update` не реализован, `create` уничтожен.

### L2.6 — email уникальность ⚠️ no-op
Status=completed за 146s, 0 изменений. Как L2.4.

### L2.7 — email filter ⚠️ код ок но без commit
Status=completed за 121s, **код корректен**:
- `user-service.ts`: `list(filter?: {email?: string})` с правильным фильтром ✓
- `routes/users.ts`: `query.email` пробрасывается ✓
- **Коммита нет** — изменения остались в working tree на auto/-ветке.

Это единственная задача из 8, где сгенерированный код был правильным и завершённым.

### L2.8 — logging middleware ❌
Provavl за 116s. Требовал создать новый файл (`src/middleware/logger.ts`) — возможно writer для новых файлов отказал.

## Aggregate

| | |
|---|---|
| Tasks attempted | 8 |
| **Git commits created** | **0/8** |
| Status=completed | 5/8 |
| Код корректный (даже без commit) | 1/8 (только L2.7) |
| Status=failed | 3/8 (L2.1, L2.3, L2.8) |
| Pure no-op (0 file changes) | 2/8 (L2.4, L2.6) |
| Битый код в "completed" | 2/5 (L2.2, L2.5) |

## VERDICT: Сценарий B — переосмыслить

По строгому критерию (git commit с правильным кодом): **0/8** успехов.
По мягкому (код в working tree корректный): **1/8** (L2.7).

В обоих случаях ≤2/8 → **Сценарий B**.

## What broke (паттерны провалов)

1. **Регрессия Committer'а / отсутствие commit-шага.** Ни одна completed-задача не привела к git commit. Изменения остаются в working tree на auto/-ветке. В прошлых бенчмарках (`git log --all`) видно `[Auto-...] Complete task: ...` коммиты — значит механизм был и сломался. Это первое, что нужно чинить.

2. **Reviewer не отлавливает синтаксические ошибки.** L2.2 и L2.5 — код буквально не компилируется (метод врезан в середину другого метода), но Reviewer пропустил и помечает status=completed. Видимо Reviewer работает на уровне семантики/диффа, а не парсит TS.

3. **Plan возвращает 0 шагов на части задач.** L2.4 (rename) и L2.6 (email уникальность) — completed за 60–146s без изменений. Возможно Planner с retrieval'ом BM25 видит существующий код и решает что задача уже выполнена, либо просто отбрасывает шаги.

4. **Жёсткий fail на ~150s** на 3 из 8 задач (L2.1, L2.3, L2.8) — похоже на Reviewer loop 3× reject → abort. Но без логов uncertain.

5. **L2.8 (новый файл)** провалилась — возможно Writer слабее на create-операциях чем на modify.

## What worked

- **L2.7 — единственный успех по коду.** GET /users?email= собрал 2 файла корректно (filter в service, query.email в route). Это доказательство что multi-file edits *в принципе* работают, когда Plan не теряется и Coder не путает методы.
- BM25 / hybrid search **не давал ложных пустых retrieval'ов** на видимых стадиях (file paths приходили правильные).

## Lessons / next iteration ideas

1. **Приоритет #1 — починить commit step.** Найти где в pipeline пропадает коммит и вернуть его. Без этого все остальные метрики бесполезны.
2. **Приоритет #2 — добавить TypeScript build/parse check в Reviewer.** Это разом отсеет L2.2 и L2.5 типа провалов (битый AST). Без TS-валидации Reviewer полагается на LLM-judge, который пропускает обвалы.
3. **Приоритет #3 — diagnose 0-step plans.** Залогировать когда Planner вернул `stepCount=0` и почему (нет retrieval контекста? LLM решил "уже сделано"?). Возможно нужен fail-fast при stepCount=0 вместо тихого completed.
4. **Не инвестировать в multi-file v1.34 retrieval** до закрытия пунктов 1–2: проблема не в retrieval, а в pipeline-output (commit) и validation (TS-check).
5. **Wall time на provalах ~150s стабильный** — указывает на 3×Reviewer reject как механизм abort. Возможно стоит уменьшить max retries до 2 и добавить более информативный `result` (сейчас "All 1 steps failed; aborting" — ноль детали).

## Raw timings

```
L2.1 — failed     151s  (3 файла)
L2.2 — completed  161s  (2 файла, код битый, no-commit)
L2.3 — failed     161s  (2 файла)
L2.4 — completed   60s  (0 changes, no-op)
L2.5 — completed  438s  (3 файла, код битый, no-commit)
L2.6 — completed  146s  (0 changes, no-op)
L2.7 — completed  121s  (2 файла, код корректный, no-commit) ← единственный hit
L2.8 — failed     116s  (1 новый + 1 mod)
─────────────────────────
TOTAL: ~22 min   COMMITS: 0/8   CORRECT_CODE: 1/8
```
