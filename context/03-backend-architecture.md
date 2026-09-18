# Backend architecture

## Decision
NestJS + TypeScript (user's strongest stack; "cannot explain your work" is a critical fail). The old Python backend of AI_Rag_demo is discarded. No LangChain: less magic, easier to defend in the technical review.

Monorepo proposal: pnpm workspaces, `apps/api` (Nest) + `apps/web` (Next).

## Core principle
Code decides security and trust. The LLM only writes prose from evidence that was already filtered.

## Request pipeline (order matters)
1. **Identity:** `X-User-Id` looked up server-side in `data/users.json` to get groups + clearance. Unknown user returns 401. Client never sends groups.
2. **ACL pre-filter:** retrieval only covers chunks the principal may see. Restricted chunks never enter the candidate set, so they cannot reach prompt, citations, logs or errors (Incident 3).
3. **Lifecycle filter:** drop retired/superseded using `status`, `effective_date`, `supersedes`. Two current docs that conflict give a "qualified" answer citing both (Incident 1).
4. **Evidence gate (deterministic, no LLM):** top score below threshold or too few chunks means refuse without calling the model.
5. **Generation:** JSON schema output (`claims[]` each with `citation_ids`), temperature 0, docs wrapped as untrusted data, no tools.
6. **Output validation:** every cited id in allowed set, every claim cited, every number/date in the answer present in cited text (Incident 2, invented SLA). Failure downgrades to qualified/refused.
7. **Audit:** request_id, user, doc ids used, decision. Never raw restricted content.

## Injection defense
- Ingest-time scan for instruction-like patterns, mark `trust: low`, exclude or quote only.
- Even a fooled model cannot widen permissions because step 2 already decided them.

## Retrieval
Hybrid: BM25/full-text + vector, fused with RRF. Covers equivalent phrasings.

## Data layout (no file parsing)
```
data/corpus/*.md   frontmatter: id, version, status, effective_date, supersedes, acl, classification
data/users.json    procurement_mgr, engineer, hr_investigator, ...
eval/cases/*.yaml  question, paraphrases, user, expected status, must_cite, must_not_cite, forbidden_strings
eval/results/latest.json
```

## Nest modules
```
IdentityModule    user lookup, guard
CorpusModule      ingest CLI: frontmatter, chunk, embed, write store
RetrievalModule   hybrid search with ACL + lifecycle filter
GenerationModule  LlmPort (OpenAiCompatLlm, FakeLlm)
GuardrailsModule  evidence gate, output validator, injection scan
AuditModule       structured log
AskController     POST /api/ask, GET /api/corpus (visible docs only), GET /api/eval/latest
```
Config via `@nestjs/config` + zod validation, fail fast, `.env.example` committed.

## Eval
`pnpm eval` runs the 4 incidents + paraphrase variants through the real pipeline, exits non-zero on failure (release blocker). `--models a,b,c` produces a pass rate / p95 / tokens table per model for the README.

## Azure mapping (Part 2)
LlmPort -> Azure OpenAI, retrieval -> Azure AI Search (hybrid + security trimming), identity -> Entra ID, injection scan -> Prompt Shields, audit -> App Insights. Migration story: swap adapters, pipeline unchanged.
