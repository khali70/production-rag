-- Switch embeddings from bge-small-en-v1.5 (384) to snowflake-arctic-embed-m-v1.5 (768).
--
-- Vectors from different models are not comparable and a vector(384) cannot be
-- cast to vector(768), so every stored embedding is dropped. documents go too:
-- their content_sha256 includes the embedding model id, and ingest rebuilds
-- both tables from the pack. Run `pnpm ingest --reindex` after this migration.

TRUNCATE chunks, documents, index_meta CASCADE;

DROP INDEX IF EXISTS chunks_embedding_hnsw;

ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(768);

CREATE INDEX chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
