# Backend architecture

## Decision
NestJS + TypeScript (user's strongest stack; "cannot explain your work" is a critical fail). The old Python backend of AI_Rag_demo is discarded. No LangChain: less magic, easier to defend in the technical review.

Monorepo: pnpm workspaces, `apps/api` (Nest) + `apps/web` (Next, not scaffolded yet).

Pinned stack as built: NestJS 12.0.3 running as ESM (`type: module`, `module: nodenext`, relative imports carry `.js`), TypeScript 6.0.3, Vitest 5.0.1 with `unplugin-swc` (SWC emits `emitDecoratorMetadata`; tsx and esbuild do not, so DI needs explicit `@Inject(Port)` tokens either way). `@nestjs/cli` is not used: version 12 wants Node >= 22.22.3 and this machine has 22.22.1, so modules are hand-written and the build is plain `tsc`, run from `dist/`. CLIs (`migrate`, `ingest`, `search`) use `NestFactory.createApplicationContext` plus `node:util` `parseArgs`.

## Core principle
Code decides security and trust. The LLM only writes prose from evidence that was already filtered.

## Request pipeline (order matters)
1. **Identity:** `X-User-Id` looked up server-side in the pack's `access/identities.json` to get groups + department. Unknown user returns 401. Client never sends groups.
2. **ACL pre-filter:** retrieval only covers chunks the principal may see (doc `allowed_groups` + classification rule groups, `deny_groups` wins, default deny, per `entitlements.json`). Soft-deleted chunks excluded in the same query. Restricted chunks never enter the candidate set, so they cannot reach prompt, citations, logs or errors (Incident 3).
3. **Lifecycle + authority:** drop retired/superseded, apply relations (matrix `amends` policy thresholds, Legal memo `qualifies` policy), then rank by tier (policy > delegated standard > advisory > record > unverified), then `effectiveFrom`. Unverified docs and employee uploads can never override an official policy. Same-rank current docs that conflict give a "qualified" answer citing both; Legal memos that `qualify` a policy are shown next to it (Incident 1). Rules in [05-vector-store.md](05-vector-store.md).
4. **Evidence gate (deterministic, no LLM):** top score below threshold or too few chunks means refuse without calling the model.
5. **Generation:** JSON schema output (`claims[]` each with `citation_ids`), temperature 0, docs wrapped as untrusted data, no tools.
6. **Output validation:** every cited id in allowed set, every claim cited, every number/date in the answer present in cited text (Incident 2, invented SLA). Failure downgrades to qualified/refused.
7. **Audit:** request_id, user, doc ids used, decision. Never raw restricted content.

## Injection defense
- Ingest-time scan for instruction-like patterns, mark `trust: low`, exclude or quote only.
- Even a fooled model cannot widen permissions because step 2 already decided them.
- Authority comes from a reviewed `authority.yaml` backed by content quotes + supplied metadata. An `Unverified` status or injection hit caps a doc at the lowest tier, so a doc cannot promote itself or retire another doc.

## Retrieval
Hybrid: BM25/full-text + vector, fused with RRF. Covers equivalent phrasings.

## Data layout (no file parsing)
```
Kentrick_Assessment_Pack_Candidate/   supplied, read-only (checksums verified at ingest)
  normalized/corpus.jsonl             8 records, required input
  access/identities.json              u-eng-104, u-hr-207, u-proc-310
  access/entitlements.json            default deny, classification rules, deny_groups overrides
data/authority.yaml                   our layer: tier, owner, relations per document, with evidence quotes
eval/cases/*.yaml  question, paraphrases, user, expected status, must_cite, must_not_cite, forbidden_strings
eval/results/latest.json
```

## Nest modules
```
IdentityModule    user lookup, guard
CorpusModule      ingest CLI: verify checksums, read JSONL + entitlements + authority.yaml, map metadata (citation, permissions, authority, lifecycle), chunk by section, embed, write store
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
