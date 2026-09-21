# What if we keep only the latest version of each document?

Thought experiment, 2026-09-21. Question: drop every older version at ingest and index only the newest one per `document_id`. Sources: the assessment pack (`manifest.json`, `normalized/corpus.jsonl`, pack README) and [08-assessment-pack.md](08-assessment-pack.md).

## Short answer
- Answers should use only the current version. That part of the idea is right.
- Deleting old versions from the index is wrong. Keep them, exclude them from answers by default, and use them only to explain what changed.
- "Latest" must mean `status = Current` and `effective_date <= today`, not "highest version number".

## What happens in this pack
Only one document has several versions:

| document_id | version | status | effective_date | Content that matters |
|---|---|---|---|---|
| APX-PROC-POL-014 | 3.0 | Current | 2026-07-01 | 6-stage process, enterprise threshold USD 50K, InfoSec required |
| APX-PROC-POL-014 | 2.1 | Retired | 2024-03-15 | old USD 100K threshold, InfoSec optional |

Keeping v3.0 alone would give a **correct answer** to the vendor question. So on the happy path the idea works. The problems are elsewhere.

## What breaks

### 1. Incident 1 asks us to explain the trust logic
The quest says the answer must come "with traceable evidence and explanation of trust logic". A good answer says: "v3.0 (effective 2026-07-01) applies. v2.1 with the USD 100K threshold is retired." With v2.1 deleted, we cannot say that. The eval case "user asks with the old threshold in mind" cannot be answered well.

### 2. The pack README tells us to keep them
The pack describes `corpus/archived/` as "retained historical documents that may still be retrieved but are not current". Dropping them contradicts the supplied data contract.

### 3. "Latest" is ambiguous, and every wrong definition is a bug
| Definition | Where it fails |
|---|---|
| Highest version number | A v4.0 already approved but effective next month would win today. String compare also breaks: "10.0" < "9.0". |
| Newest `effective_date` | Same future-date problem. Also a later correction to an old line could win. |
| Last row ingested | Depends on file order, not on the business. |
| `status = Current` and effective already | Correct. Status is the business decision; the date confirms it is in force. |

Also: the latest version itself can be `Retired`, with no replacement (a policy withdrawn completely). "Keep latest" would then keep a retired document as if it were valid. Status must be checked anyway.

### 4. It does not solve conflicts between different documents
Incident 1 also involves other document ids, which are not versions of each other:
- APX-PROC-MTX-006 amends the approval thresholds under POL-014.
- APX-LEGAL-MEM-027 qualifies the Legal stage and states it does not supersede POL-014.
- APX-ENG-KB-991 is unverified.

"Latest version only" does nothing for these. We still need the authority tiers and relations from [05-vector-store.md](05-vector-store.md).

### 5. Audit and history questions fail
Questions like "which rule applied to a vendor approved in 2025?" or "what changed in v3.0?" need old versions. Reviewers of a wrong answer also need to see which versions existed at that time.

### 6. Rollback is harder
If v3.0 is found to be wrong and the business reverts, v2.1 must come back. With it deleted, that means re-ingesting from source instead of changing one status.

## What we gain by dropping them
- A slightly smaller index. In the pack: one fewer document. At production scale, old versions are a small share of 60K documents. Not a real saving.
- Zero risk of the old version leaking into answers. But the status filter already gives that: retired chunks are excluded inside the search query, so they never reach the prompt.

## Recommendation
- Index every version. `status` and `effective_from` live on every chunk.
- Default search: `includeStatuses = ["current"]`. Retired chunks never reach answer generation.
- Built 2026-09-21: `effective_from <= asOf` in the search pre-filter (`SearchQuery.asOf`, default today UTC, CLI `--as-of`). A Current version that is not in force yet is excluded. Status is today's state, so `asOf` in the past is not a true "what applied then" query.
- To add: "explain" path only: include retired, label them clearly as retired, never cite them as current guidance.
- To add: eval case where the answer must never contain the v2.1 threshold as current guidance, and must mention that v2.1 is retired when the question refers to it.
- Azure design: same filter in Azure AI Search, or a separate archive index if old versions grow large.

## Need more info
- The pack does not define what each status means or whether a non-retired old version can exist. The pack has no such case.
- Whether assessors expect retired versions to be mentioned in the answer or only in citations. The quest wording ("explanation of trust logic") suggests mention.
