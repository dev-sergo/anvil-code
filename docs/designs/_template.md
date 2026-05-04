# Design — v1.X &lt;tag&gt;

> **Status:** DRAFT — pre-impl. **Date:** YYYY-MM-DD.
> **Order:** идёт после v1.X-prev / параллельно с v1.X-other (если применимо).
> **Links:** [предыдущий design / связанные итерации].

> Целевой ориентир: ~150-250 строк. Режем prose, оставляем числа / контракты / evidence chain / acceptance criteria / open questions.

## TL;DR

Один параграф (3-5 предложений): что меняем, зачем, какой ожидаемый measurable outcome.

## 1. Goals & non-goals

| | |
|---|---|
| **G1** | Конкретная цель с measurable acceptance |
| **G2** | ... |
| **G3** | ... |
| **NG1** | Что НЕ делаем в этой итерации (обычно — то, что хочется добавить, но это другая итерация) |
| **NG2** | ... |

## 2. Архитектура

```
Если есть структурный сдвиг — диаграмма + новые/изменённые интерфейсы.
Иначе короткое описание изменений + затронутые файлы.
```

**Затронутые файлы:**
- [packages/foo/src/bar.ts](../../packages/foo/src/bar.ts) — что меняем
- [packages/baz/src/qux.ts](../../packages/baz/src/qux.ts) — что меняем

## 3. Phases (как делаем по порядку)

### Phase A — &lt;short title&gt;
- Конкретные шаги
- Tests added: N
- Acceptance: ...

### Phase B — &lt;short title&gt;
- ...

### Phase C — bench (всегда последняя phase для итераций с поведенческим изменением)
- Tasks: L1.1 ×N / L4.1 ×N / scale ×N
- Target metrics: ...
- Run-file: [docs/benchmarks/runs/YYYY-MM-DD-v1.X-tag.md](../benchmarks/runs/YYYY-MM-DD-v1.X-tag.md)

## 4. Acceptance criteria

- [ ] AC1 — конкретный observable signal (тесты зелёные / bench score / wall-time)
- [ ] AC2 — ...
- [ ] AC3 — ...

## 5. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Что может пойти не так | HIGH/MED/LOW | Как смягчаем |

## 6. Open questions

- Что не решено и требует обсуждения / эксперимента до commit'a кода
- ...

## 7. Alternatives considered (одна-две строки на каждую)

- **Альтернатива X** — отвергнуто потому что Y
- **Альтернатива Z** — отвергнуто потому что W

## 8. Out of scope (что хочется, но в другой итерации)

- ...
