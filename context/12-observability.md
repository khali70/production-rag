# Observability: query log, full tracing, sampled quality checks

Three things, often confused, built as one path:

1. **Query log** - one small row per request. Metrics, dashboards, alerts. Cheap, kept long.
2. **Trace** - the full story of one request, query to answer, including prompt and evidence text.
   Expensive, kept shorter, used for incidents.
3. **Quality samples** - traces pulled into an eval set and scored, by rules and by an LLM judge,
   to catch regressions the four fixed incidents do not cover.

Nothing exists today. `AuditModule` in [03-backend-architecture.md](03-backend-architecture.md) was never
built, there is no log table in `0001_init.sql`, and the only trace is the local `pnpm trace` CLI, which
prints to a file in `traces/` and is not tied to an HTTP request.

## Decision: store full content in traces

This is an internal system, so traces store the question, the prompt, the evidence text and the raw model
output verbatim. That is the deliberate choice, and it buys real incident forensics: during an incident you
see exactly what the model saw, with no reconstruction step.

It moves the risk rather than removing it. A trace can contain text from restricted documents, so the trace
store becomes a copy of the corpus with different permissions. Therefore:

- The trace store is **privileged**: a dedicated role, not general monitoring access. Ops and dashboards use
  the query log, which holds ids only, and never need the trace store.
- **Every trace read is itself audited.** Who opened which request's trace, and when.
- Trace retention is short (30 days suggested), and the query log carries the long history.
- Traces live in the same region, with the same residency and CMK rules as the corpus.
- The `debug` payload in `AskResult` is already marked "never return to an unprivileged caller". Traces make
  that comment a real access boundary rather than a convention.

A trace is not an answer path. It never widens what a user sees. It only records what the pipeline already
decided.

## Layer 1: query log

One append-only row per `/api/ask`, written after the answer is finalized. Ids, decisions, counters, timings.
No text except the question.

```
request_id          uuid primary key
trace_id            text            -- links to the trace and to OTel
ts                  timestamptz
user_id             text
groups_hash         text            -- sha256 of sorted groups: cache key and ACL analysis
question_raw        text
question_norm       text            -- lowercased, trimmed: dedupe and clustering
question_hash       text
mode                text            -- retrieval | llm
status              text            -- answered | qualified | refused
refuse_reason       text            -- gate_cosine | no_visible_chunks | validator | llm_error | circuit_open
retrieved_chunk_ids text[]
cited_doc_ids       text[]
best_cosine         numeric
rerank_used         bool
validator_warnings  text[]
injection_flagged   bool
embedding_model_id  text
llm_model_id        text
index_version       text
tokens_in           int
tokens_out          int
latency_ms          jsonb           -- {embed, search, rerank, llm, validate, total}
error_code          text
```

Small enough to keep for a year or more, which is what makes trend analysis possible after traces expire.

### What it answers

| Question | How |
|---|---|
| What do people actually ask? | Cluster `question_norm` by embedding, count per cluster |
| Where do we refuse too much? | `refuse_reason` by cluster and by department |
| What is the corpus missing? | High-volume clusters with `status = refused` and low `best_cosine` |
| Which documents carry the load? | `cited_doc_ids` frequency, and documents never cited at all |
| Is retrieval healthy? | `best_cosine` distribution and gate-trip rate over time |
| Did a release regress? | Every metric above, split by `llm_model_id` and `index_version` |
| Cost and latency | Token and `latency_ms` percentiles per day, cost per answered question |
| Is the ACL holding? | Standing query: any row where a chunk outside the user's groups appears in `retrieved_chunk_ids`. Must be zero |

That last one is the cheapest continuous proof of incident 3, and it should run on a schedule with a page
attached, not only during investigations.

## Layer 2: trace

One trace per request, spans named after the stages the local `ask.trace.ts` already prints, so the two
views match:

```
ask  (root)     request_id, user, groups, mode, status, total_ms
 |- identity    groups resolved, source (token | graph | cache)
 |- embed       model_id, dim, prefix_scheme, cache_hit, ms
 |- search      candidates, best_cosine, filter, ms
 |- gate        decision, threshold, reason      <- refusals end here, no llm span follows
 |- rerank      model_id, pool, kept, min_score, ms
 |- authority   primaries, dropped_retired, relations_applied, tie_broken_by
 |- prompt      template_hash, evidence_doc_ids, prompt_tokens, FULL system + user prompt
 |- llm         model_id, temperature, seed, tokens, finish_reason, retries, FULL raw output
 |- parse       json_ok, retry_used, zod_errors
 '- validate    claims, dropped_uncited, warnings, final_status
```

Span attributes stay small (ids, counts, decisions) so they are queryable. The bulky parts, prompt, evidence
text and raw output, are attached as a **trace payload blob** keyed by `request_id`, not as span attributes.
This keeps the tracing backend fast and puts the sensitive content behind its own access check.

### Payload contents

```
request_id, trace_id, ts
user { id, groups, department }
question
options            -- gate, margins, topK, versionChunks, relatedChunks, rerank config
retrieved[]        -- chunk id, doc id, version, cosine, rerank score, text
dropped[]          -- off-topic and retired chunks, with the reason each was dropped
evidence[]         -- the resolved EvidenceDoc list, as the prompt builder saw it
prompt             -- system + user, verbatim
llm_raw[]          -- every attempt, including retries and reasoning text
answer             -- final Answer object, with warnings
manifest           -- index_version, model ids, dims, prefix scheme, template hash, seed
```

`dropped[]` matters more than it looks. Most "why did it answer that?" questions are actually "why was the
right document not there?", and the drop reason answers it directly: off-topic margin, retired status, ACL,
or precedence.

### Sampling

- **100%** of refusals, qualified answers, validator warnings, injection hits and errors.
- **5-10%** of clean answered responses, plus anything explicitly flagged by a user.
- The query log row is always written, for every request, with no sampling. Only the heavy payload is sampled.

A trace is also written on demand: any request carrying a debug header from an authorized caller is traced
in full, which is how support reproduces a user complaint.

### Incident workflow

1. User reports a bad answer, quoting the `request_id` returned in the response header.
2. Open the trace. The stage that decided is usually obvious: refused with a high `best_cosine` means the
   gate is misconfigured; `dropped_uncited > 0` means the model is drifting from evidence; a missing
   expected document with `dropped_retired` set means precedence, not retrieval.
3. Read the payload for the exact prompt and evidence.
4. For a suspected leak: run the standing ACL query over the affected window, not just the one request.
5. Promote the case into `eval/cases/` **before** fixing, so the fix is proven and stays proven.

### Replay

`pnpm replay <request_id>` reruns the manifest through the current code: same chunks, same options, same
model settings. Two outcomes, both useful:

- Reproduces the bad answer: the bug is in current code, prompt or model. Debug it locally.
- Does not reproduce: something changed underneath. That is the finding.

Replay needs the corpus state to still exist, which is why soft delete and version retention must outlive
trace retention, and why the manifest records `index_version` so replay can refuse loudly against a rebuilt
index rather than replaying quietly against different data. Same discipline as `IndexMismatchError`.

## Layer 3: quality samples and the LLM judge

The eval set today covers the four incidents. Real traffic finds the cases nobody thought of. The loop:

1. **Sample weekly** from the query log: top clusters by volume, all refusals with high `best_cosine`,
   all validator warnings, all user-flagged requests.
2. **Score each one automatically** first, because most failures are mechanical and need no judge:
   - every claim cites an id in the allowed evidence set
   - every number and date in the answer appears in the cited text
   - no cited document is outside the user's permitted set (hard fail, never a score)
   - status matches the gate decision
3. **Then an LLM judge** on what rules cannot check: is the answer supported by the cited evidence, is it
   responsive to the question, did it refuse when it should have answered, is it unnecessarily hedged.
   The judge sees question, evidence text and answer, and returns a structured verdict with a reason.
4. **Human review of disagreements** only: judge fails a case the rules passed, or vice versa. That is a
   small queue, and it is where new eval cases come from.
5. **Promote** reviewed cases into `eval/cases/*.yaml` with the existing fields (question, paraphrases,
   user, expected status, `must_cite`, `must_not_cite`, `forbidden_strings`).

### Judge rules

- The judge is a **regression detector, not an oracle**. It gates releases through trend changes and through
  cases a human has reviewed, never by itself deciding a single answer is right.
- Different model from the answering model. A model grading its own output agrees with itself.
- Temperature 0, structured output, explicit rubric, verdict plus reason.
- Calibrate against a human-labeled set and track judge-versus-human agreement over time. An uncalibrated
  judge is a number that feels like quality.
- The judge never sees anything the asking user could not see. It scores a trace that already passed the
  ACL filter, so it cannot introduce a leak, and it must never be given a widened evidence set.
- Track judge cost separately. It is a sampled offline job, so it can use a larger model than the answer path.

### Offline eval versus online sampling

| | Offline eval (`pnpm eval`) | Online sampling |
|---|---|---|
| Input | Versioned cases in `eval/cases/` | Real traffic from the query log |
| When | Every CI run, release blocker | Continuous, scored in batches |
| Checks | Deterministic assertions, exact | Rules plus LLM judge, statistical |
| Purpose | Stop a known regression from shipping | Find the unknown ones, then turn them into offline cases |

They feed each other. Online sampling without offline promotion produces dashboards nobody acts on.

## Implementation shape

One port, same hexagonal pattern as the rest:

```
ports/observability.port.ts
  record(event: QueryLogEvent): void         -- never throws, never blocks the response
  trace(payload: TracePayload): void         -- sampled

adapters/observability/pg           -- local: query_log + trace_payload tables
adapters/observability/azure        -- App Insights custom event + OTel spans + blob payload
adapters/observability/null         -- tests
```

Rules for the writer:

- Called from the controller layer, not from `AnswerService`, so CLI and eval runs can pick a different sink.
- Buffered and batched. A log write never sits on the request's latency budget.
- A write failure never fails the request. Sustained write failures raise an alert.
- One guard function builds the event from the finalized result. It is the only place that touches `debug`,
  so a future change cannot leak by accident.

## Azure mapping

- OpenTelemetry SDK in the Nest app, exporting to Application Insights. `request_id` is the correlation id
  and is passed through APIM, so a user-reported slow request links back to the gateway entry.
- Query log: App Insights custom events for the live window, continuous export to ADLS Gen2 or Azure Data
  Explorer for long retention and clustering jobs.
- Trace payloads: blob storage with CMK, a privileged role, immutable (WORM) for the retention window, and
  storage-level audit logging on reads.
- Alerts in Azure Monitor: refusal-rate jump, P95 breach, validator-warning rate rising, ACL check non-zero
  (page immediately), tokens per request drifting up, log write failures.

## Build order

1. `request_id` generated per request, returned in the response header, threaded through every stage.
   Nothing else works without it.
2. `0004_query_log.sql` plus the pg adapter, wired in `ask.controller.ts`.
3. Trace payload table and sampling.
4. `pnpm replay <request_id>`.
5. `pnpm queries` for the analysis SQL above.
6. Sampling job plus LLM judge, feeding `eval/cases/`.
7. OTel spans and Azure adapters.

Steps 1-5 are local, useful immediately, and they are what make the Azure story in
[11-azure-architecture.md](11-azure-architecture.md) concrete rather than aspirational.
