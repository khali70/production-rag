# Context index

Brainstorm notes for the Production RAG project (Code Quests #88, Kentrick.ai).
Captured 2026-09-18. These are decisions and proposals, not final specs.

| File | Topic |
|---|---|
| [01-spec-summary.md](01-spec-summary.md) | Quest requirements, incidents, deliverables, deadlines |
| [02-frontend.md](02-frontend.md) | Frontend plan (reuse of AI_Rag_demo shell) |
| [03-backend-architecture.md](03-backend-architecture.md) | NestJS backend, request pipeline, modules |
| [04-llm-and-embeddings.md](04-llm-and-embeddings.md) | Swappable LLM + embedding ports, model candidates |
| [05-vector-store.md](05-vector-store.md) | Metadata model (citation, permissions, authority, soft delete), VectorStorePort, pgvector schema, store options |
| [06-sizing.md](06-sizing.md) | Size and speed estimates for 60K docs |
| [07-open-questions.md](07-open-questions.md) | Decisions still pending |
| [08-assessment-pack.md](08-assessment-pack.md) | Real pack contents: fields, docs, users, access rule, expected outcomes |
| [09-what-if-latest-version-only.md](09-what-if-latest-version-only.md) | Thought experiment: index only the latest version of each doc |
| [10-what-if-allowed-groups-only.md](10-what-if-allowed-groups-only.md) | Thought experiment: filter by allowed_groups only, skip classification |
| [12-observability.md](12-observability.md) | Query log, full request tracing, replay, sampled quality checks with an LLM judge |

Production scaling designs live in [`scaling/`](../scaling/):

| File | Topic |
|---|---|
| [azure-openai.md](../scaling/azure-openai.md) | Part 2: Azure deployment with Azure OpenAI + AI Search, scaling strategy, trust boundaries, failure handling, migration path |
| [postgres.md](../scaling/postgres.md) | Same targets on Postgres + pgvector: index memory limits, replicas, pooling, reduction levers, when to migrate |

Links:
- Spec: https://code-quests.com/quests-details/?id=88
- Previous project (frontend source): https://github.com/khali70/AI_Rag_demo
