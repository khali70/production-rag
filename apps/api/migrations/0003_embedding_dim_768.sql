-- Restores chunks.embedding to vector(768) for snowflake-arctic-embed-m-v1.5.
--
-- A short-lived migration (0002_embedding_dim_1024, since removed) had moved
-- the column to vector(1024) on some databases. Both tables are rebuilt from
-- the pack, so emptying them is safe: run `pnpm ingest --reindex` afterwards.
-- On a fresh database this is a no-op apart from rebuilding the index.
--
-- EMBEDDING_DIM in .env must match this column.

TRUNCATE chunks, documents, index_meta CASCADE;
DROP INDEX IF EXISTS chunks_embedding_hnsw;
ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(768);
CREATE INDEX chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
