# Open questions

Frontend
- [ ] Next static export served by Nest (one command) vs two processes via docker-compose?
- [ ] Keep chat sessions/history or single Q&A? (lean single: multi-turn adds context-leak risk)
- [ ] Upgrade to Next 15 / React 19 or stay on 14?

Backend
- [x] pnpm monorepo `apps/api` + `apps/web`. Built: `apps/api` (NestJS 12, ESM, `tsc` build, Vitest + unplugin-swc). `apps/web` not scaffolded yet.
- [ ] Ollama as prerequisite, or in-process node-llama-cpp? (LLM only: embeddings are in-process transformers.js, decided.)
- [x] ACL model: follow `entitlements.json`: doc allowed_groups + classification rule groups + deny_groups (deny wins), default deny. See 05.
- [x] Pack JSONL fields mapped (see 08). Gaps filled by section split at ingest + `data/authority.yaml`.
- [x] Employee uploads in corpus? No. `unverified` tier covers ENG-KB-991 locally; upload tier is Azure design only.
- [x] Authority tiers + ranks confirmed (policy 100, delegated standard 90, advisory 70, record 50, unverified 10) and live in `data/authority.yaml` with evidence quotes. Added a second axis: `level` (0 company-wide, 1 function head, 2 team), which outranks tier in precedence. See 05.
- [ ] Vendor answer for u-proc-310: include the Legal memo renewal path always, or only when the question mentions renewals?
- [ ] u-hr-207 asking a general leave question: keep HR-CASE-778 out unless the question targets the case?
- [ ] Soft delete retention before hard purge (default 30 days)?
- [x] Docker pgvector (`pgvector/pgvector:0.8.6-pg17`, host port 5435; 5432-5434 were already taken on this machine). 0.8 is required for `hnsw.iterative_scan`.
- [ ] Qdrant as real second adapter now, or stub later?
- [x] Does the corpus include Arabic? No, English only: bge-small is enough.

Answered by the vector-store build (2026-09-20): store, schema, ingest CLI, embedding adapter and ACL enforcement are implemented and tested (57 unit + 27 contract).

Next step: LLM adapter + `/api/ask` + guardrails, then the eval runner, then the web shell.
