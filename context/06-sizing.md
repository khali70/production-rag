# Sizing estimates (rough, not benchmarked)

Assumption from user: 60K docs, 400-500 pages each.

## Volume
- 60K x ~450 pages = ~27M pages.
- ~500 tokens/page = ~13.5B tokens.
- 512-token chunks, ~1 per page = ~30M chunks.

## Storage (1024 dims)
- Raw vectors float32: 30M x 4 KB = ~120 GB.
- pgvector HNSW index roughly doubles that.
- Chunk text: ~60 GB.
- Total: 300+ GB.

Reduction options:
- halfvec (float16): ~2x smaller.
- Matryoshka / fewer dims (256-512): 2-4x smaller.
- Binary quantization + rescore: ~30x smaller for the first-pass index.

## Speed
- HNSW query: ~10-50 ms when index fits in RAM.
- Selective ACL filters slow it down; disk-bound queries can take seconds.
- Budget is P95 < 6 s end to end, so retrieval must stay a small slice; LLM dominates.

## Ingest
- Initial embed of ~13.5B tokens: not feasible on CPU. Via API at small-model rates, roughly low hundreds of USD (verify current pricing).
- Daily churn: 200 docs x 450 pages = ~90K chunks/day, easy.
