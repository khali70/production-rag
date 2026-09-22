<div align="center">

# Production RAG

### Enterprise knowledge answers that are grounded, permission-safe, and honest when they don't know.

A CPU-only Retrieval-Augmented Generation service where **code decides security and trust**, and the LLM only writes prose from evidence that was already filtered.

![Node](https://img.shields.io/badge/node-%3E%3D22.12-339933?logo=node.js&logoColor=white)
![NestJS](https://img.shields.io/badge/NestJS-12-E0234E?logo=nestjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![pgvector](https://img.shields.io/badge/Postgres-pgvector-4169E1?logo=postgresql&logoColor=white)
![Tests](https://img.shields.io/badge/tests-89%20passing-brightgreen)
![GPU](https://img.shields.io/badge/GPU-not%20required-lightgrey)

Built for [Code Quests #88 (Kentrick.ai): Production RAG](https://code-quests.com/quests-details/?id=88)

![Ask Playground answering a procurement question with cited claims](docs/screenshots/answer-procurement.png)

</div>

---

## Why this project

Most RAG demos answer confidently. Enterprise RAG has to answer **correctly, for the right person, or not at all**. This project targets the four failure modes that actually hurt companies:

| Incident | What goes wrong in naive RAG | What this project does |
|---|---|---|
| **Wrong policy becomes the answer** | A retired v2.1 policy outranks the current v3 because it scored higher | Lifecycle + authority layer: status, supersedes/amends relations, org level and document tier decide precedence, not cosine |
| **Convincing unsupported answer** | The model invents an SLA that the contract never states | Output validator: every claim must cite allowed evidence; unsupported numbers downgrade the answer to *qualified* or *refused* |
| **Security failure** | An engineer asking about leave sees a confidential HR investigation; a document says "ignore your rules" | ACL pre-filter in SQL (restricted chunks never enter the candidate set) + ingest-time prompt-injection scanner that caps malicious docs at the lowest trust tier |
| **Undetected regression** | A model or prompt change silently breaks behavior | Unit + contract test suites and a traceable pipeline run for every question |

## See it in action

**Same pipeline, different user.** An engineer asking about a confidential HR case gets a safe refusal. The restricted document was never retrieved, so the LLM was never called and nothing leaks into prompts, citations or logs.

![Engineer is refused access to a restricted HR document](docs/screenshots/refused-engineer.png)

<details>
<summary><b>Full diagnostics view</b> (embedding stats, retrieved chunks, evidence, raw LLM output)</summary>

![Full diagnostics panel](docs/screenshots/diagnostics-full.png)

</details>

## How it works

```mermaid
flowchart LR
    Q[Question + user id] --> I[Identity<br/>server-side groups]
    I --> E[Embed query<br/>arctic-embed-m, CPU]
    E --> S[Hybrid search<br/>vector + full-text, RRF<br/>ACL + lifecycle in SQL]
    S --> G{Evidence gate<br/>no LLM}
    G -- too weak --> R[Refuse safely]
    G -- ok --> RR[Optional<br/>cross-encoder rerank]
    RR --> A[Authority + precedence<br/>level, tier, relations]
    A --> P[Prompt<br/>docs wrapped as untrusted data]
    P --> L[Local LLM<br/>JSON schema output]
    L --> V[Validator<br/>citations, allowed ids]
    V --> OUT[answered / qualified / refused]
```

Order matters. Permissions are decided **before** retrieval, so even a fully fooled model cannot widen them.

### Highlights

- **Permission-consistent by construction.** Identity is resolved server-side from the pack's `identities.json`; `allowed_groups`, classification rules and `deny_groups` are enforced inside the SQL query, default deny.
- **Authority, not just relevance.** A reviewed [`data/authority.yaml`](data/authority.yaml) assigns each document a tier and org level, backed by quotes that are re-verified against the document text at every ingest. A quote that drifts fails the ingest.
- **Prompt-injection resistant.** [`injection.scanner.ts`](apps/api/src/modules/corpus/injection.scanner.ts) flags instruction-like content at ingest; flagged docs are forced to `unverified` and can never override policy.
- **Refuses without hallucinating.** A deterministic evidence gate refuses before any LLM call when nothing trustworthy is visible.
- **Structured, cited answers.** The LLM returns `claims[]` with `citation_ids`; uncited claims are dropped and reported as warnings.
- **Supply-chain integrity.** Pack files are checked against `checksums.sha256` before ingest.
- **Hexagonal architecture.** Ports for embeddings, reranker, LLM and vector store with real and fake adapters, so every stage is testable offline and swappable (e.g. Azure OpenAI + Azure AI Search in production).
- **Fully local, CPU only.** In-process ONNX embeddings via `@huggingface/transformers`, Postgres + pgvector in Docker, any OpenAI-compatible local LLM (Ollama, llama.cpp, vLLM).

## Tech stack

| Layer | Choice |
|---|---|
| API | NestJS 12 (ESM), TypeScript 6 |
| Vector store | Postgres 17 + pgvector 0.8 (hybrid vector + full-text) |
| Embeddings | `Snowflake/snowflake-arctic-embed-m-v1.5` (768d), in-process ONNX |
| Reranker (optional) | `Xenova/bge-reranker-base` cross-encoder |
| LLM | Any OpenAI-compatible endpoint, default `qwen3.5:4b` on Ollama |
| Config | `@nestjs/config` + zod, fail-fast validation |
| Tests | Vitest (unit + pgvector contract tests) |

## Quick start

**Prerequisites:** Node >= 22.12, pnpm 10, Docker, and [Ollama](https://ollama.com) (or any OpenAI-compatible LLM server).

```bash
git clone https://github.com/khali70/production-rag.git
```

```bash
cd production-rag && pnpm install
```

```bash
cp .env.example .env
```

```bash
ollama pull qwen3.5:4b
```

```bash
pnpm db:up
```

```bash
pnpm build && pnpm migrate && pnpm ingest
```

```bash
pnpm --filter api start
```

Open **http://localhost:3001/**, pick a user, ask a question. The first run downloads the embedding model (~440 MB) into `.cache/models`; set `EMBEDDING_ALLOW_REMOTE=false` afterwards for fully offline runs.

### CLI

```bash
pnpm --filter api ask --user u-proc-310 "What is our process for approving a new enterprise vendor?"
```

```bash
pnpm trace "who approves a regulated vendor"
```

`trace` prints every pipeline step: embed, search, gate, rerank, authority, prompt, LLM, parse, validate.

### Tests

```bash
pnpm test
```

```bash
pnpm test:contract
```

## Project layout

```
apps/api/src
  ports/            EmbeddingPort, LlmPort, RerankerPort, VectorStorePort
  adapters/         transformers, openai-compat, pgvector, and fakes for tests
  domain/           precedence + tier rules (pure functions)
  modules/corpus/   pack loader, checksum verifier, ACL resolver, chunker, injection scanner, authority
  modules/answer/   embed -> search -> rerank -> generate stages, prompt builder, validator
  modules/http/     playground page + JSON API (localhost only)
  cli/              migrate, ingest, search, ask, trace
data/authority.yaml reviewed authority layer with evidence quotes
context/            design notes and decision records
Kentrick_Assessment_Pack_Candidate/  supplied synthetic corpus (read-only)
```

## Security notes

- The playground lets you **impersonate any pack user** for demo purposes, so the server binds to `127.0.0.1` only. Do not expose it to a network.
- All corpus data is **synthetic**, supplied by the quest. No real people, suppliers or contracts.

## Design docs

Decisions, trade-offs and thought experiments live in [`context/`](context/README.md): backend architecture, model choice, vector store design, sizing for 60K documents, and "what if" analyses.

## Links

- Quest: [Code Quests #88 (Kentrick.ai)](https://code-quests.com/quests-details/?id=88)
- Author: [@khali70](https://github.com/khali70)

If this project is useful to you, a star helps others find it.
