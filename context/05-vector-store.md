# Vector store

## Port (ACL scope is mandatory)
```ts
export type AccessScope = {         // built server-side from identity, never from the request
  principalId: string;
  groups: string[];
  maxClassification: "public" | "internal" | "confidential" | "restricted";
};

export type ChunkRecord = {
  chunkId: string;
  docId: string;
  docVersion: number;
  text: string;
  embedding: number[];
  allowedGroups: string[];
  classification: AccessScope["maxClassification"];
  status: "current" | "superseded" | "retired";
  effectiveFrom: string;
  trust: "normal" | "low";
  deletedAt?: string | null;
};

export type SearchQuery = {
  text: string;
  embedding: number[];
  topK: number;
  includeStatuses?: ChunkRecord["status"][];   // default ["current"]
};

export abstract class VectorStorePort {
  abstract search(scope: AccessScope, q: SearchQuery): Promise<ScoredChunk[]>;
  abstract upsert(chunks: ChunkRecord[]): Promise<void>;
  abstract softDeleteDoc(docId: string, at: Date): Promise<void>;
  abstract setDocStatus(docId: string, version: number, status: ChunkRecord["status"]): Promise<void>;
  abstract purgeDeleted(olderThan: Date): Promise<number>;
  abstract indexInfo(): Promise<{ embeddingModel: string; dim: number }>;
}
```

## Rules
- No search without scope. Adapters apply it as a pre-filter during the vector search, never as a post-filter (recall loss + restricted chunks loaded into memory).
- Soft-deleted rows excluded inside the adapter, not by callers.
- One shared contract test suite runs against every adapter: engineer never gets HR chunks, soft-deleted gone, retired excluded by default, same query + user gives same ids, selective-filter recall case. New adapter must pass before use.

## Options

| Option | ACL filter | Soft delete | Hybrid | Local | Scale / Azure |
|---|---|---|---|---|---|
| pgvector (default) | SQL `allowed_groups && $groups` + GIN | `deleted_at IS NULL` | Postgres FTS + RRF | docker | Azure Database for PostgreSQL supports pgvector |
| Qdrant (2nd adapter) | indexed payload filter, strong filtered HNSW | payload flag | sparse vectors | docker | not Azure-native (AKS self-host) |
| Azure AI Search (prod design) | `search.in` security trimming | field + filter | built-in hybrid + semantic ranker | no emulator | the Azure answer |
| LanceDB | SQL-like where | flag | FTS | embedded | weak Azure story |
| In-memory | JS filter | flag | naive | tests | no |

## Why pgvector as local default
- Version change updates chunk status + doc table in one transaction (Incident 1, ~200 changes/day).
- Everything is plain SQL, easy to explain.
- Caveat: selective filters can starve HNSW results. Enable pgvector iterative index scans and keep a contract test for it.

## Azure AI Search vs PostgreSQL + pgvector
- Azure AI Search: managed search service. Push docs, it indexes. Built-in hybrid, semantic reranker, security-trimming filter pattern. No local run, higher cost, not a system of record.
- PostgreSQL + pgvector: a database with a vector column. You own search, filter and ranking SQL. Transactions, joins, versioning, runs locally.
- Plan: Postgres as local store of truth; production design uses AI Search as the search layer fed from the store.
