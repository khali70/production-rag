-- Switch embeddings from snowflake-arctic-embed-m-v1.5 (768) to snowflake-arctic-embed-l-v2.0 (1024).
--
-- Vectors from different models are not comparable and a vector(768) cannot be
-- cast to vector(1024), so every stored embedding is dropped. documents go too:
-- their content_sha256 includes the embedding model id, and ingest rebuilds
-- both tables from the pack. Run `pnpm ingest --reindex` after this migration.
--
-- EMBEDDING_DIM in .env must match this column.

TRUNCATE chunks, documents, index_meta CASCADE;

DROP INDEX IF EXISTS chunks_embedding_hnsw;

ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(1024);

CREATE INDEX chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
