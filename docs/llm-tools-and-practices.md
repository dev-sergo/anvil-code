# Таблицы инструментов и практик

## 1. Базовый стек: язык и фреймворки

| Инструмент | Что это | Зачем нужно | Пример использования |
|---|---|---|---|
| TypeScript (strict) | Типизированный JS | Безопасность типов, автодокументация, интеграция с Zod-схемами | `type ChatRequest = { messages: Message[]; stream: boolean }` |
| Node.js ≥20 | Runtime | Web Streams, нативный fetch, `AbortSignal.any()` | `AbortSignal.timeout(30_000)` для таймаутов LLM |
| Fastify | HTTP-фреймворк | Быстрее Express, нативная поддержка схем и стриминга | `app.post('/chat', { schema }, handler)` |
| NestJS | Структурный фреймворк | Когда команда большая и нужен DI, модули | `@Injectable() class RAGService {}` |
| Vitest | Тест-раннер | Быстрее Jest, нативно работает с TS/ESM | `test('retriever returns top-k', async () => {...})` |
| Zod | Валидация и схемы | Один источник истины: типы + валидация + JSON Schema для LLM | `z.object({ name: z.string() }).describe(...)` |

## 2. LangChain.js: ядро

| Объект | Что делает | Когда использовать | Пример |
|---|---|---|---|
| RunnableSequence | Линейная цепочка шагов | Любой пайплайн prompt → LLM → parser | `RunnableSequence.from([prompt, model, parser])` |
| RunnableParallel | Параллельное выполнение | RAG-паттерн: контекст + вопрос одновременно | `{ context: retriever, question: passthrough }` |
| RunnableLambda | Обёртка функции | Кастомная трансформация между шагами | `new RunnableLambda({ func: docs => docs.map(...) })` |
| RunnablePassthrough | Пропускает вход дальше | Сохранить исходный вход параллельно с обработкой | `RunnablePassthrough.assign({ context: ... })` |
| ChatPromptTemplate | Шаблон промпта с переменными | Структурированные system/human/AI сообщения | `ChatPromptTemplate.fromMessages([['system', '...']])` |
| StringOutputParser | Извлекает текст из AIMessage | Финальный шаг, когда нужна строка | `.pipe(new StringOutputParser())` |
| withStructuredOutput | Принуждает LLM вернуть схему | Извлечение данных, классификация, structured ответы | `model.withStructuredOutput(ZodSchema)` |
| createToolCallingAgent | Современный агент с tool use | Агенты на моделях с native function calling | `createToolCallingAgent({ llm, tools, prompt })` |
| AgentExecutor | Runtime для простых агентов | Одноуровневые агенты без сложного состояния | `new AgentExecutor({ agent, tools, maxIterations: 5 })` |
| LangGraph | Stateful граф для агентов | Циклы, ветвления, human-in-the-loop, многошаговые агенты | `new StateGraph(...).addNode(...).addEdge(...)` |

## 3. RAG: компоненты пайплайна

| Компонент | Что делает | Когда использовать | Пример инструмента |
|---|---|---|---|
| Document Loader | Загружает документы из источников | Любой RAG начинается с этого | CheerioWebBaseLoader, PDFLoader, GithubRepoLoader |
| Recursive Splitter | Базовый чанкинг по разделителям | Дефолт для большинства текстов | `new RecursiveCharacterTextSplitter({ chunkSize: 800 })` |
| Semantic Splitter | Чанкинг по смыслу через embeddings | Длинные документы со смешанными темами | `new SemanticChunker(embeddings)` |
| Markdown/Code Splitter | Document-aware чанкинг | Markdown-документация, исходный код | `RecursiveCharacterTextSplitter.fromLanguage('markdown')` |
| Embedding модель | Текст → вектор | Семантический поиск | OpenAI `text-embedding-3-large`, Voyage `voyage-3-large` |
| Vector Store | Хранит и ищет векторы | Хранилище эмбеддингов | pgvector, Qdrant, Pinecone, Chroma |
| VectorStoreRetriever | Базовый top-k поиск | Простой RAG | `vectorStore.asRetriever({ k: 4 })` |
| MultiQueryRetriever | Несколько переформулировок запроса | Нечёткие пользовательские запросы | `MultiQueryRetriever.fromLLM({ llm, retriever })` |
| Hybrid Search | Dense + BM25 (sparse) с RRF | Production-RAG, борьба с vocabulary gap | pgvector + tsvector, Qdrant native sparse |
| Re-ranker | Сортирует top-30 → top-5 | Сильно улучшает релевантность | Cohere Rerank 3, BGE-reranker-v2 |
| ContextualCompressionRetriever | Обёртка для re-ranking | Подключение реранкера в LangChain | `new ContextualCompressionRetriever({ baseRetriever, baseCompressor })` |
| Parent Document Retriever | Ищем по чанкам, отдаём родителей | Когда мелкие чанки точнее ищут, но крупные лучше для LLM | `new ParentDocumentRetriever({ vectorstore, docstore })` |

## 4. Векторные БД

| БД | Тип | Когда выбирать | Особенности |
|---|---|---|---|
| pgvector | Расширение Postgres | Уже есть Postgres; хочется одну БД для всего | HNSW-индексы, гибридный поиск через tsvector, ACID |
| Qdrant | Standalone (Rust) | Нужна отдельная vector DB, self-host | Быстрый, отличная фильтрация, native sparse vectors |
| Pinecone | Managed cloud | Не хочется DevOps, бюджет позволяет | Дорогой на масштабе, простой старт |
| Chroma | Standalone (Python) | Прототипы, dev-окружение | Простой, но реже в проде |
| Weaviate | Standalone (Go) | Сложные графовые связи + векторы | Богатая фильтрация, GraphQL API |

## 5. LLM провайдеры и работа с API

| Тема | Инструменты | Зачем | Пример |
|---|---|---|---|
| SDK | `@anthropic-ai/sdk`, `openai` | Прямые вызовы API без LangChain | `await anthropic.messages.create({...})` |
| Подсчёт токенов | `tiktoken`, `@anthropic-ai/tokenizer` | Оценка стоимости заранее, fit в context window | `encoding.encode(text).length` |
| Стриминг | SSE через Fastify, `for await` | UX (реактивность), отмена запросов | `for await (const chunk of stream) reply.raw.write(...)` |
| Отмена запросов | `AbortController`, `AbortSignal.timeout()` | Не платить за ненужные токены, таймауты | `chain.invoke(input, { signal })` |
| Rate limiting | `bottleneck`, `p-limit` | Уважать лимиты провайдера | `limiter.schedule(() => model.invoke(...))` |
| Retry | `p-retry` | Exponential backoff на 429/5xx | `pRetry(() => fetch(...), { retries: 3 })` |
| Prompt caching | Anthropic `cache_control`, OpenAI auto | Экономия 90% на повторных длинных промптах | `{ type: 'text', text: '...', cache_control: { type: 'ephemeral' } }` |
| Tool use | Native API провайдера | Function calling, агенты | `tools: [{ name, description, input_schema }]` |
| Семантический кеш | Redis + embeddings | Кешировать ответы похожих вопросов | Поиск по cosine similarity > 0.95 |

## 6. Prompt engineering

| Техника | Что это | Когда применять | Пример |
|---|---|---|---|
| System prompt | Инструкция роли модели | Всегда — задаёт поведение | `"Ты эксперт по налогам РФ. Отвечай только по контексту."` |
| XML-теги | Разделители секций | Anthropic-модели — обязательно | `<context>...</context><question>...</question>` |
| Few-shot examples | Примеры в промпте | Сложные форматы, специфичные стили | 2–5 пар `<example><input>...</input><output>...</output></example>` |
| Chain-of-Thought | "Рассуждай пошагово" | Логические задачи, многошаговые | `"Перед ответом разложи задачу на шаги в <thinking>"` |
| Structured output (Zod) | Принудительная схема | Извлечение данных, классификация | `model.withStructuredOutput(z.object({...}))` |
| HyDE | Гипотетический ответ для поиска | Поиск, когда вопрос ≠ стиль документов | LLM генерирует "ответ", по нему ищем embedding |
| Query decomposition | Разбиение на подвопросы | Сложные мульти-факторные вопросы | "Сравни X и Y" → "Что такое X?" + "Что такое Y?" |
| Prompt versioning | Промпты как артефакты | Production — всегда | LangSmith Hub, Langfuse Prompts |

## 7. Observability и оценка

| Инструмент | Что делает | Когда использовать | Пример |
|---|---|---|---|
| LangSmith | Трейсинг + evals + prompts | Хочется managed, бюджет есть | `LANGCHAIN_TRACING_V2=true` — автотрейс |
| Langfuse | Open-source аналог LangSmith | Self-host, compliance, контроль данных | `new CallbackHandler({ publicKey, secretKey })` |
| Promptfoo | A/B тесты промптов и моделей | CI-проверки, регресс-наборы | `promptfoo eval` с YAML-конфигом |
| RAGAS | Метрики качества RAG | После каждого изменения чанкинга/поиска | `faithfulness`, `answer_relevancy`, `context_precision` |
| Autoevals | LLM-as-judge на JS | Кастомные evals в Vitest | `Factuality({ output, expected, input })` |
| OpenTelemetry | Стандарт трейсинга | Интеграция с общей observability стэкой | OTEL exporter → Langfuse/Datadog |

## 8. Метрики RAGAS

| Метрика | Что измеряет | Требует ground truth | Что делать при низкой |
|---|---|---|---|
| Faithfulness | Ответ основан на контексте, нет галлюцинаций | Нет | Ужесточить system prompt, более строгая модель |
| Answer Relevancy | Ответ отвечает на вопрос | Нет | Улучшить промпт, добавить few-shot |
| Context Precision | Доля релевантных чанков в top-k | Да (ideally) | Re-ranking, лучше embedding-модель |
| Context Recall | Покрывает ли контекст всё нужное | Да | Увеличить k, hybrid search, MultiQuery |
| Context Entities Recall | Все ли сущности извлечены | Да | Лучшие embeddings, специфичные для домена |
| Noise Sensitivity | Устойчивость к нерелевантным чанкам | Да | Compression, более строгий threshold |

## 9. Безопасность и Guardrails

| Инструмент | Защищает от | Где применять | Пример |
|---|---|---|---|
| Zod-валидация | Невалидный input/output | Все границы системы | `RequestSchema.parse(body)` |
| Prompt injection detection | Манипуляции пользователя | На входе, перед LLM | Классификатор или LLM-judge |
| PII detection | Утечки персональных данных | Input + output | `microsoft/presidio`, regex+LLM |
| LLM-as-judge guardrail | Токсичность, off-topic | На выходе | Дешёвая модель проверяет ответ |
| Llama Guard | Категории harm content | Output фильтрация | Отдельная классификационная модель |
| Rate limiting per user | Abuse, DoS | API gateway | Redis + sliding window |
| Token budget per session | Финансовый abuse | Per-user лимиты | Счётчик токенов в Redis |

## 10. Платформы и оркестрация

| Инструмент | Что это | Когда нужен | Пример |
|---|---|---|---|
| Flowise | Визуальный no-code constructor | Прототипы для нетех команды, быстрые demo | Docker-контейнер, custom nodes на TS |
| LangGraph Platform | Деплой агентов | Production-агенты с состоянием | Persistence, time-travel debugging |
| Vercel AI SDK | Тонкая обёртка над провайдерами | Когда LangChain — overkill | `streamText({ model, messages })` |
| LiteLLM | Прокси для LLM-провайдеров | Унификация API, fallback между моделями | OpenAI-совместимый эндпоинт для всех |
