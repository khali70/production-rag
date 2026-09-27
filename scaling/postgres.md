# Scaling on Postgres + pgvector (no managed search service)

The second production path. Same pipeline, same ports, but retrieval stays on the store that is already
built and tested: Postgres 17 + pgvector, with the SQL in
[search.sql.ts](../apps/api/src/adapters/vector-store/pgvector/search.sql.ts) unchanged.

Targets the same assumptions as [azure-openai.md](azure-openai.md): 60,000 docs (~180 GB), ~200 changes/day,
5,000 employees, 20 req/s peak, P95 < 6 s, zero unauthorized disclosure, region residency.

## Why this path exists

| Reason | Detail |
|---|---|
| Zero retrieval code change | The adapter, the contract tests and the ACL predicate already work. Nothing is rewritten, so nothing new can be got wrong |
| One system of record | Documents, chunks, authority, lifecycle and the query log live in one database, with real transactions. An ACL change and its index update are the same commit |
| Portable | Runs on Azure Database for PostgreSQL Flexible Server, on AWS RDS, or on-prem hardware. No lock-in, and it fits an air-gapped deployment |
| Cheaper at small and medium scale | Below a few million chunks it is clearly cheaper than a managed search tier |
| Honest limit | It stops scaling before AI Search does. The break point is stated below rather than discovered in production |

Deployment: Azure Database for PostgreSQL Flexible Server (or self-hosted Postgres 17 with pgvector 0.8).
The API, the LLM, embeddings, ingest, identity and observability are identical to
[azure-openai.md](azure-openai.md). Only the `VectorStorePort` implementation differs.

## The binding constraint: index memory

Query speed holds only while the HNSW index is in RAM. Once it spills to disk, latency goes from tens of
milliseconds to seconds and the 6 s budget is gone.

Estimates from [06-sizing.md](../context/06-sizing.md), at 768 dimensions:

| Chunks | float32 vectors | +HNSW (~2x) | halfvec (fp16) | halfvec + 512 dims |
|---|---|---|---|---|
| 3M | ~9 GB | ~18 GB | ~9 GB | ~6 GB |
| 10M | ~31 GB | ~62 GB | ~31 GB | ~20 GB |
| 30M | ~92 GB | ~184 GB | ~92 GB | ~61 GB |

So the sizing rule is simple: **RAM must exceed the index size, with headroom for the heap and for
connections.** 3M chunks is comfortable on a mid-size instance. 10M needs a large memory-optimized one.
30M needs the reduction levers below, or a different store.

### Reduction levers, in the order to apply them

1. **halfvec (fp16).** Roughly half the storage and memory, with negligible recall loss in practice.
   Changing the column type is a reindex, and `index_meta` already forces a clean re-embed path.
2. **Fewer dimensions.** Matryoshka-style truncation to 512 or 256 dims, if the eval numbers hold. Another
   1.5-3x. Verify with the eval suite, never by feel.
3. **Binary quantization plus rescore.** First pass over a tiny binary index, then rescore the top few
   hundred candidates against the full vectors. Around 30x smaller for the first pass. This is the lever
   that makes 30M chunks plausible on one machine, at the cost of a more complex query path.
4. **Chunk fewer, not smaller.** Deduplicate boilerplate (headers, footers, repeated legal blocks) at
   ingest. In a policy corpus this is often a double-digit percentage of all chunks, and it is free recall.

## Scaling the query path

**Read replicas.** Ask traffic is read-only. One primary for writes and ingest, two or more read replicas
for search, spread across zones. 20 req/s is one vector query each, which two warm replicas handle with
room to spare. Replicas also give the SLA, not just throughput.

**Connection pooling.** Postgres does not like hundreds of connections, and about 100 requests are in
flight at peak (Little's law: 20 req/s x ~5 s). Put PgBouncer in transaction mode in front, and keep the
Node pool small and bounded. Note the existing `SET LOCAL` discipline in the adapter: session-level
settings would leak across pooled connections, and transaction pooling makes that failure mode worse, not
better. `SET LOCAL` inside the query transaction is correct and must stay.

**Search settings.** `hnsw.ef_search = 100` and `hnsw.iterative_scan = relaxed_order` are already set per
transaction. Iterative scan is what stops a selective ACL filter from starving the index scan, which is the
main correctness risk of filtered vector search and is covered by a contract test.

**Partitioning.** Partition `chunks` by `document_id` hash, or by tenant or department if a natural
boundary exists. Partitioning by a field that appears in the ACL filter lets most queries touch a fraction
of the data. Without a natural boundary, partitioning mainly helps maintenance (reindex and vacuum per
partition) rather than query time.

**Keep the filter in the query.** The ACL predicate is interpolated into both legs of the hybrid query on
purpose. A shared CTE gets materialized and disables the HNSW scan, and a post-filter silently loses recall
while briefly holding restricted chunks in the candidate set. That reasoning is in
[05-vector-store.md](../context/05-vector-store.md) and does not change at any scale.

**Hybrid and reranking.** Full-text (GIN on `tsv`) plus vector, fused with RRF, exactly as built. There is
no semantic ranker here, so the cross-encoder reranker stays in the pipeline. It runs on the API tier, so
budget for it: it is CPU work on the request path, unlike the Azure variant where ranking is inside the
search service.

## Scaling the write path

- 200 changes/day is ~90K chunks/day at worst. Trivial for a single primary.
- The initial backfill is the real load: bulk insert with `COPY`, then build the HNSW index **after** the
  data is loaded, with `maintenance_work_mem` raised and parallel workers on. Building the index first and
  inserting into it is many times slower.
- Ingest workers write through a queue and are idempotent on `(document_id, version, content_hash)`, the
  same contract as the Azure path.
- **ACL-only changes must not re-embed.** `UPDATE chunks SET allowed_groups = ...` touches no vector and no
  index. This is the one place where Postgres is plainly better than a managed search service: the document
  row and its chunk rows change in a single transaction, so there is no window where the two disagree.
- Autovacuum needs tuning for the churn. A heavily updated `chunks` table bloats, and a bloated HNSW index
  loses the memory budget it depends on. Schedule a periodic `REINDEX CONCURRENTLY` per partition.

## Latency budget (P95 6 s)

| Stage | Budget | Note |
|---|---|---|
| Auth + identity | 100 ms | Entra token, group claims |
| Query embedding | 200 ms | Azure OpenAI, or in-process ONNX if fully self-hosted (adds ~1.4 s CPU, see the README timings) |
| Hybrid search | 300 ms | while the index is in RAM |
| Cross-encoder rerank | 400 ms | API-tier CPU, skip it when the gate is already decisive |
| Authority, gate, prompt | 50 ms | |
| LLM | 4.5 s | the dominant term, same as the Azure path |
| Validation | 50 ms | |

If embeddings are also self-hosted on CPU, the budget does not close. Either serve embeddings from a GPU
node or a hosted endpoint, or accept a higher P95. This is the honest trade of a fully offline deployment.

## High availability and DR

- Zone-redundant HA on Flexible Server (synchronous standby), or Patroni plus streaming replication when
  self-hosted.
- Read replicas in other zones, promoted on failure.
- Point-in-time restore covers the corpus and the query log together, which is a real advantage when
  investigating an incident: one restore reproduces the exact state the pipeline saw.
- Cross-region replica inside the residency geography for DR.
- Backups and WAL encrypted with customer-managed keys.

## Failure handling

Identical to [azure-openai.md](azure-openai.md), with the store-specific cases:

| Failure | Behavior |
|---|---|
| Primary down, standby promoting | Reads continue from replicas. Refuse only if replicas are also unreachable. Ingest pauses |
| Replica lag | Serve from the primary or refuse. Never answer from a replica whose ACL updates have not landed. Lag above a threshold is a page, because a stale ACL is a disclosure risk |
| Index scan starved by a selective filter | Iterative scan handles it. The contract test guards the regression |
| Index no longer fits in RAM | Latency alert fires long before the budget breaks. That is the signal to apply a reduction lever or migrate |
| `index_version` mismatch | `IndexMismatchError`. Refuse rather than return quietly wrong results |

## When to leave this path

Move retrieval to Azure AI Search when any of these hold:

- Working set exceeds the memory of the largest instance you are willing to pay for, after halfvec and
  dimension reduction (roughly past 10-30M chunks at 768 dims).
- P95 search latency creeps up while chunk count grows, which means the index is spilling to disk.
- Reindex and vacuum windows start to conflict with ingest.
- You need a semantic ranker, and moving the cross-encoder off the API tier is worth more than the
  operational simplicity of one database.

The migration is an adapter swap behind `VectorStorePort`, validated by the existing contract suite. That
is the whole point of the hexagonal layout: the pipeline, the guardrails, the ACL rules and the tests are
untouched.

## Recommendation

Start here. Run the pilot corpus and the first production slice on Postgres, because it is built, tested
and transactional, and it removes a large unknown from the rollout. Instrument the chunk count and the
search P95 from day one ([12-observability.md](../context/12-observability.md)), and treat the memory
break point above as a planned migration trigger rather than an incident.
