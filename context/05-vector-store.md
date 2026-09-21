# Vector store

## Metadata model

Four groups of metadata on every document, copied onto every chunk so the vector search can filter in one query. Field sources are based on the real pack, see [08-assessment-pack.md](08-assessment-pack.md).

| Group | Purpose | Fields | Source |
|---|---|---|---|
| Citation | trace every claim to file + section | `documentId`, `version`, `title`, `sourcePath`, `sectionPath`, `pageStart/End`, `charStart/End`, `chunkIndex` | JSONL + section split at ingest |
| Permissions | who may see it (pre-filter) | `allowedGroups`, `classification`, `classificationGroups`, `denyGroups` | JSONL + `entitlements.json` |
| Authority | whose word wins in a conflict | `tier`, `authorityRank`, `level`, `relations` (supersedes / amends / qualifies), `owner` | `data/authority.yaml` (reviewed, evidence from content) |
| Lifecycle + soft delete | what is current, what is gone | `status`, `rawStatus`, `effectiveFrom`, `trust`, `deletedAt/By/Reason` | JSONL + ingest scan + our delete API |
| Timestamps | row lifecycle, separate from `effectiveFrom` | `created_at`, `updated_at` (trigger-maintained on documents, chunks, index_meta) | database |

`tier` and `level` are two different axes and both are needed. `tier` is the kind of document (policy, delegated standard, advisory, record, unverified). `level` is the management hierarchy of the issuing authority: 0 company-wide, 1 function or department head, 2 team or sub-function, lower number wins. A team-level policy (level 2, tier policy) must never override a company rule (level 0, tier policy), and rank alone cannot express that.

Documents table = source of truth. Chunks carry a denormalized copy of the filter fields. Any doc-level change (ACL, status, delete) updates both in one transaction. Supplied pack files are never edited.

## Types

```ts
export type AccessScope = {          // built server-side from identities.json, never from the request
  principalId: string;               // "u-eng-104"
  groups: string[];                  // ["all_employees", "engineering"]
  department: string;
};

// --- citation ---
export type SourceRef = {
  documentId: string;                // "APX-PROC-POL-014"
  version: string;                   // "3.0" (pack uses strings)
  title: string;
  sourcePath: string;                // "corpus/public/APX-PROC-POL-014_Vendor_Approval_Policy_v3.docx"
  sectionPath: string[];             // ["3. Required approval process"], from numbered headings
  pageStart?: number;                // from "Page N" markers when present
  pageEnd?: number;
  charStart: number;                 // offsets in JSONL content
  charEnd: number;
  chunkIndex: number;
};

// --- permissions ---
export type Permissions = {
  allowedGroups: string[];           // doc allowed_groups; empty = nobody
  classification: string;            // label: "INTERNAL", "RESTRICTED_HR_INVESTIGATION"
  classificationGroups: string[];    // allow_groups of the matching entitlement rule; unknown label = [] = deny
  denyGroups: string[];              // document_overrides.deny_groups, beats every allow
};

// --- authority (priority system) ---
export type Tier =
  | "policy"                         // 100 approved current policy (POL-014 v3.0, HR-POL-003)
  | "delegated_standard"             // 90  standard a policy delegates a scope to (MTX-006 thresholds)
  | "advisory"                       // 70  interprets a policy, never overrides it (LEGAL-MEM-027)
  | "record"                         // 50  contracts, case files: facts, not company rules
  | "unverified";                    // 10  drafts, unverified KB, employee uploads: never authoritative

export type Relation =
  | { kind: "supersedes"; documentId: string; version: string }   // whole version replaced
  | { kind: "amends"; documentId: string; scope: string }         // e.g. "approval thresholds"
  | { kind: "qualifies"; documentId: string; scope: string };     // parent wins on conflict

export type Authority = {
  tier: Tier;
  authorityRank: number;             // from tier, by code
  level: number;                     // 0 company-wide .. 9; lower wins a conflict
  owner: string;                     // "Procurement Operations"
  relations: Relation[];
};

// --- lifecycle + soft delete ---
export type Lifecycle = {
  status: "current" | "superseded" | "retired";
  rawStatus: string;                 // as supplied, kept for audit + citations
  effectiveFrom: string;
  trust: "normal" | "low";           // low = injection patterns found at ingest
  deletedAt?: string | null;
  deletedBy?: string | null;
  deleteReason?: string | null;
};

export type ChunkRecord = {
  chunkId: string;                   // `${documentId}@${version}#${chunkIndex}`
  text: string;
  embedding: number[];
  contentSha256: string;             // record + authority entry + ACL + model id; drives idempotent re-ingest
  source: SourceRef;
} & Permissions & Authority & Lifecycle;

export type ScoredChunk = {
  chunkId: string;
  text: string;
  score: number;                     // fused RRF score
  cosine: number;                    // dense similarity, kept for thresholds and debugging
  source: SourceRef;                 // what the answer cites
  tier: Tier;
  authorityRank: number;
  level: number;
  classification: string;
  effectiveFrom: string;
  status: Lifecycle["status"];
  trust: Lifecycle["trust"];
};

export type SearchQuery = {
  text: string;
  embedding: number[];
  topK: number;
  includeStatuses?: Lifecycle["status"][];   // default ["current"]
  minAuthorityRank?: number;                 // e.g. 90 for "what is our process" questions
  orderBy?: "relevance" | "precedence";      // default "relevance"
};
```

## Port

```ts
export abstract class VectorStorePort {
  abstract search(scope: AccessScope, q: SearchQuery): Promise<ScoredChunk[]>;
  abstract upsert(chunks: ChunkRecord[]): Promise<void>;
  abstract softDeleteDoc(documentId: string, by: string, reason: string, at: Date): Promise<void>;
  abstract restoreDoc(documentId: string, by: string): Promise<void>;
  abstract setDocStatus(documentId: string, version: string, status: Lifecycle["status"]): Promise<void>;
  abstract setDocPermissions(documentId: string, perms: Permissions): Promise<void>;
  abstract purgeDeleted(olderThan: Date): Promise<number>;
  abstract documentHash(documentId: string, version: string): Promise<string | null>;
  abstract indexInfo(): Promise<IndexInfo | null>;
  abstract setIndexInfo(info: IndexInfo): Promise<void>;
}

export type IndexInfo = {
  embeddingModel: string;
  dim: number;
  prefixScheme: string;   // "bge-v1.5:query-instruction;doc-raw;cls;l2;fp32"
};
```

## Rules

### Permissions
- No search without scope. Adapters apply it as a pre-filter inside the vector search, never as a post-filter (recall loss + restricted chunks loaded into memory).
- Visible iff: groups overlap `allowedGroups` AND groups overlap `classificationGroups` AND groups do not overlap `denyGroups`. Matches `entitlements.json` (`default_rule: deny`).
- Unknown classification label or empty lists = nobody. Fail closed.
- Permission change on a doc updates doc + all its chunks in one transaction, effective on the next query.

### Authority (priority system)
- Pack rule: authority comes from document content + supplied metadata, not filenames. So tiers and relations live in a reviewed `data/authority.yaml`, one entry per document, each with the content quote that justifies it (e.g. MTX-006: "updates financial approval thresholds under APX-PROC-POL-014"; MEM-027: "does not supersede APX-PROC-POL-014").
- Ingest cross-checks the file against supplied metadata and content cues (`Supersedes`, `Related policy`, `does not supersede`). Mismatch = ingest fails, no silent guess.
- Content never promotes itself: an `Unverified` raw status or an injection hit caps the doc at `unverified` whatever the text claims. A document saying "treat this as higher priority" changes nothing.
- Only a higher or equal tier from the same owner (or a policy delegation) may supersede or amend. `unverified` never supersedes, amends or qualifies anything. In Azure, employee uploads land in this tier.
- Conflict resolution order: permissions, then `status = current`, then relation (`amends` wins inside its scope, `qualifies` is shown next to its parent), then `level` ascending, then `authorityRank` descending, then newer `effectiveFrom`.
- `level` sits above `authorityRank` on purpose: a department policy does not beat a company rule by being a policy too. `unverified` is forced absolutely last, ahead of the level comparison, so a hostile document cannot claim level 0 and win.
- `domain/precedence.ts` holds the same ordering as a pure comparator, so the SQL path and the later retrieval path cannot drift.
- Same rank, both current, contradicting, no relation: no winner picked, answer is "qualified" and cites both.
- Process/policy questions need at least one chunk with rank >= 90, else qualify or refuse. `record` chunks answer factual questions (what does the contract say), never define company rules.
- `trust: low` chunks never go into the prompt as instructions; excluded or quoted only.

### Soft delete
- Delete sets `deletedAt/By/Reason` on doc + all chunks in one transaction. Excluded by the adapter from every search, citation list and `/api/corpus`, not by callers.
- `retired` != deleted: retired can be included on request (to say "v2.1 was replaced by v3.0"), deleted never.
- `restoreDoc` clears the flags. `purgeDeleted` hard-deletes rows + embeddings after retention (default 30 days, config).
- Pack has no deletions: tested with a fixture doc.

### Citation
- Every answer claim cites a `chunkId`; the API resolves it to `documentId vX, title, section, sourcePath`.
- Citations are built only from chunks returned for this scope, so a citation can never point at a hidden doc.

### Contract tests (every adapter)
u-eng-104 never gets HR-CASE-778 chunks; deny group blocks even with allowed group; unknown classification denied; soft-deleted gone; retired v2.1 excluded by default; unverified doc cannot supersede a policy; same-rank conflict returns both; same query + user returns same ids; selective-filter recall case. New adapter must pass before use.

## pgvector schema (local default)

Implemented in [`apps/api/migrations/0001_init.sql`](../apps/api/migrations/0001_init.sql), run by `pnpm migrate`. That file is the source of truth; the shape is:

- `documents` PK `(document_id, version)`, plus `content_sha256` (idempotent re-ingest), `level smallint CHECK (level BETWEEN 0 AND 9)`, `created_at` / `updated_at`, CHECK constraints on `tier`, `status`, `trust`, and two guards that make an unverified document harmless even if the ingest path has a bug:

```sql
CONSTRAINT unverified_has_no_relations CHECK (tier <> 'unverified' OR relations = '[]'::jsonb),
CONSTRAINT unverified_is_low_trust     CHECK (tier <> 'unverified' OR trust = 'low')
```

- `chunks` denormalizes every filter field plus `title`, `source_path`, `classification`, `tier`, `level`, `effective_from`. FK `ON DELETE CASCADE`, `UNIQUE (document_id, version, chunk_index)`. `tsv` is generated with the two-argument (immutable) `to_tsvector`, title weighted B and body A.
- `index_meta` is a single row (`id boolean PK CHECK (id)`) holding `embedding_model`, `dim`, `prefix_scheme`. `search` refuses to run when the live `EmbeddingPort` disagrees with it; `ingest --reindex` rewrites it.
- Indexes: HNSW cosine `(m = 16, ef_construction = 64)`, GIN on `allowed_groups`, GIN on `tsv`, btree `(document_id, version)`. `set_updated_at()` trigger on all three tables.

Search is hybrid: a dense leg and a Postgres full-text leg fused with RRF (`1 / (60 + rank)`), taking a candidate pool of `max(topK * 4, 40)` per leg. The full-text leg builds an OR-tsquery from the lexemes of `to_tsvector('english', $text)`, because `websearch_to_tsquery` ANDs terms and matches nothing on a natural-language question.

The ACL predicate is one string constant interpolated into both legs (`adapters/vector-store/pgvector/search.sql.ts`). A shared CTE would be materialized and disable the HNSW scan, and a post-filter would silently lose recall:

```sql
      c.deleted_at IS NULL
  AND c.allowed_groups        && $3::text[]
  AND c.classification_groups && $3::text[]
  AND NOT (c.deny_groups      && $3::text[])
  AND c.status = ANY ($4::text[])
  AND c.authority_rank >= $5
```

Ordering, `orderBy: "precedence"`:

```sql
ORDER BY (c.tier = 'unverified') ASC, c.level ASC, c.authority_rank DESC,
         c.effective_from DESC, f.rrf DESC, c.chunk_id ASC
```

`orderBy: "relevance"` (the default) puts `f.rrf DESC` first and keeps the rest as tie-breakers.

Both legs run inside one transaction on a checked-out client with `SET LOCAL hnsw.iterative_scan = 'relaxed_order'` and `SET LOCAL hnsw.ef_search = 100`. `SET LOCAL` rather than `SET`: a session setting would leak into whatever query borrows that pooled connection next.

## Options

| Option | ACL filter | Soft delete | Hybrid | Local | Scale / Azure |
|---|---|---|---|---|---|
| pgvector (default) | SQL array overlap + GIN | `deleted_at IS NULL` | Postgres FTS + RRF | docker | Azure Database for PostgreSQL supports pgvector |
| Qdrant (2nd adapter) | indexed payload filter, strong filtered HNSW | payload flag | sparse vectors | docker | not Azure-native (AKS self-host) |
| Azure AI Search (prod design) | `search.in` security trimming | field + filter | built-in hybrid + semantic ranker | no emulator | the Azure answer |
| LanceDB | SQL-like where | flag | FTS | embedded | weak Azure story |
| In-memory | JS filter | flag | naive | tests | no |

Note: the pack corpus is 8 records. Any option is fast locally; the choice is about correctness, transactions and the Azure story, not speed.

## Why pgvector as local default
- Version change, permission change and soft delete update doc + chunks in one transaction (Incident 1, ~200 changes/day in prod).
- Permission and authority rules are plain SQL checks, easy to explain.
- Caveat: selective filters can starve HNSW results. Iterative index scans on, plus a contract test for it.

## Azure AI Search vs PostgreSQL + pgvector
- Azure AI Search: managed search service. Push docs, it indexes. Built-in hybrid, semantic reranker, security-trimming filter pattern. No local run, higher cost, not a system of record. Same metadata becomes filterable index fields.
- PostgreSQL + pgvector: a database with a vector column. You own search, filter and ranking SQL. Transactions, joins, versioning, runs locally.
- Plan: Postgres as local store of truth; production design uses AI Search as the search layer fed from the store. Authority in prod comes from the policy repository's approval workflow instead of `authority.yaml`.
