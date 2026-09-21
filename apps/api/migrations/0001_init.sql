-- Vector store schema.
--
-- documents is the source of truth. chunks carry a denormalized copy of every
-- field the search filter touches, so ACL, lifecycle and authority are decided
-- inside one SQL statement instead of in application code after the fact.
--
-- Metadata groups on both tables:
--   citation    document_id, version, title, source_path, section_path, char offsets, chunk_index
--   permissions allowed_groups, classification, classification_groups, deny_groups
--   authority   tier, authority_rank, level, owner, relations
--   lifecycle   status, raw_status, effective_from, trust, deleted_*, created_at, updated_at
--
-- level is the management hierarchy of the issuing authority: 0 is company-wide,
-- and a lower number wins a conflict. It is deliberately separate from tier,
-- which describes the kind of document. A team standard (level 2) can never
-- override a company rule (level 0) even when both are tier 'policy'.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE documents (
  document_id           text        NOT NULL,
  version               text        NOT NULL,
  title                 text        NOT NULL,
  source_path           text        NOT NULL,
  -- hash of record + authority entry + resolved ACL + embedding model id.
  -- Lets re-ingest skip unchanged documents without re-embedding them.
  content_sha256        text        NOT NULL,

  -- permissions
  allowed_groups        text[]      NOT NULL DEFAULT '{}',
  classification        text        NOT NULL,
  classification_groups text[]      NOT NULL DEFAULT '{}',
  deny_groups           text[]      NOT NULL DEFAULT '{}',

  -- authority
  tier                  text        NOT NULL
                        CHECK (tier IN ('policy','delegated_standard','advisory','record','unverified')),
  authority_rank        smallint    NOT NULL,
  level                 smallint    NOT NULL CHECK (level BETWEEN 0 AND 9),
  owner                 text        NOT NULL,
  relations             jsonb       NOT NULL DEFAULT '[]',

  -- lifecycle
  status                text        NOT NULL CHECK (status IN ('current','superseded','retired')),
  raw_status            text        NOT NULL,
  effective_from        date        NOT NULL,
  trust                 text        NOT NULL DEFAULT 'normal' CHECK (trust IN ('normal','low')),
  deleted_at            timestamptz,
  deleted_by            text,
  delete_reason         text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (document_id, version),

  -- An unverified document can never claim authority over another document,
  -- and is never trusted as an instruction. Enforced in the database so a bug
  -- in the ingest path cannot promote a malicious document.
  CONSTRAINT unverified_has_no_relations CHECK (tier <> 'unverified' OR relations = '[]'::jsonb),
  CONSTRAINT unverified_is_low_trust     CHECK (tier <> 'unverified' OR trust = 'low')
);

CREATE TABLE chunks (
  chunk_id              text PRIMARY KEY,   -- ${document_id}@${version}#${chunk_index}
  document_id           text        NOT NULL,
  version               text        NOT NULL,
  chunk_index           int         NOT NULL,

  -- citation
  title                 text        NOT NULL,
  source_path           text        NOT NULL,
  section_path          text[]      NOT NULL,
  page_start            int,
  page_end              int,
  char_start            int         NOT NULL,
  char_end              int         NOT NULL,

  text                  text        NOT NULL,
  embedding             vector(384) NOT NULL,
  -- Two-argument to_tsvector is immutable, which a generated column requires.
  tsv                   tsvector GENERATED ALWAYS AS (
                          setweight(to_tsvector('english', title), 'B') ||
                          setweight(to_tsvector('english', text), 'A')
                        ) STORED,

  -- permissions (denormalized from documents)
  allowed_groups        text[]      NOT NULL,
  classification        text        NOT NULL,
  classification_groups text[]      NOT NULL,
  deny_groups           text[]      NOT NULL,

  -- authority + lifecycle (denormalized from documents)
  tier                  text        NOT NULL,
  authority_rank        smallint    NOT NULL,
  level                 smallint    NOT NULL,
  status                text        NOT NULL,
  effective_from        date        NOT NULL,
  trust                 text        NOT NULL,
  deleted_at            timestamptz,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (document_id, version, chunk_index),
  FOREIGN KEY (document_id, version) REFERENCES documents (document_id, version) ON DELETE CASCADE
);

-- Single row describing how every embedding in chunks was produced.
-- search refuses to run when the live EmbeddingPort disagrees with it.
CREATE TABLE index_meta (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),
  embedding_model text        NOT NULL,
  dim             int         NOT NULL,
  prefix_scheme   text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chunks_embedding_hnsw    ON chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX chunks_allowed_groups_gin ON chunks USING gin (allowed_groups);
CREATE INDEX chunks_tsv_gin            ON chunks USING gin (tsv);
CREATE INDEX chunks_doc                ON chunks (document_id, version);

CREATE TRIGGER documents_updated_at  BEFORE UPDATE ON documents  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER chunks_updated_at     BEFORE UPDATE ON chunks     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER index_meta_updated_at BEFORE UPDATE ON index_meta FOR EACH ROW EXECUTE FUNCTION set_updated_at();
