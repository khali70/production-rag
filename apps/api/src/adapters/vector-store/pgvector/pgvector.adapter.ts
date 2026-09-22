import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import pgvector from "pgvector/pg";
import type {
  AccessScope,
  ChunkRecord,
  IndexInfo,
  Permissions,
  Relation,
  ScoredChunk,
  SearchQuery,
  Status,
  Tier,
  VersionQuery,
} from "../../../domain/types.js";
import { EmbeddingPort } from "../../../ports/embedding.port.js";
import {
  IndexMismatchError,
  MissingScopeError,
  VectorStorePort,
} from "../../../ports/vector-store.port.js";
import { PgPool } from "./pg.pool.js";
import { VERSIONS_SQL, buildSearchSql } from "./search.sql.js";

type ChunkRow = {
  chunk_id: string;
  document_id: string;
  version: string;
  chunk_index: number;
  title: string;
  source_path: string;
  section_path: string[];
  page_start: number | null;
  page_end: number | null;
  char_start: number;
  char_end: number;
  text: string;
  classification: string;
  tier: Tier;
  authority_rank: number;
  level: number;
  status: Status;
  effective_from: Date | string;
  trust: "normal" | "low";
  owner: string;
  relations: Relation[];
  score: string | number;
  cosine: string | number | null;
};

/** effective_from is a DATE; pg returns a Date in local time. Keep it as YYYY-MM-DD. */
function toDateString(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The as-of date is computed here, not with SQL CURRENT_DATE, so it does not
 * depend on the database session time zone. UTC by default; the pack gives
 * no company time zone.
 */
function resolveAsOf(asOf: string | undefined): string {
  if (asOf === undefined) return new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`))) {
    throw new Error(`Invalid asOf "${asOf}". Expected YYYY-MM-DD.`);
  }
  return asOf;
}

@Injectable()
export class PgVectorStoreAdapter extends VectorStorePort {
  constructor(
    @Inject(PgPool) private readonly db: PgPool,
    @Inject(EmbeddingPort) private readonly embeddings: EmbeddingPort,
  ) {
    super();
  }

  // --- search -------------------------------------------------------------

  async search(scope: AccessScope, q: SearchQuery): Promise<ScoredChunk[]> {
    if (!scope || !Array.isArray(scope.groups) || scope.groups.length === 0) {
      throw new MissingScopeError();
    }

    const statuses: Status[] = q.includeStatuses ?? ["current"];
    const minRank = q.minAuthorityRank ?? 0;
    const asOf = resolveAsOf(q.asOf);
    const topK = Math.max(1, q.topK);
    // Over-fetch per leg so RRF has something to fuse and selective ACL
    // filters still leave a usable pool.
    const candidates = Math.max(topK * 4, 40);

    return this.db.transaction(async (client) => {
      await this.assertIndexMatches(client);

      // Selective filters can starve a plain HNSW scan: without iterative
      // scan the index returns its ef_search candidates, the ACL filter
      // discards most of them, and rare-group rows never surface.
      await client.query("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
      await client.query("SET LOCAL hnsw.ef_search = 100");

      const { rows } = await client.query<ChunkRow>(buildSearchSql(q.orderBy ?? "relevance"), [
        pgvector.toSql(q.embedding),
        q.text,
        scope.groups,
        statuses,
        minRank,
        candidates,
        topK,
        asOf,
        q.minCosine ?? null,
      ]);

      return rows.map((row) => this.toScoredChunk(row));
    });
  }

  async versions(scope: AccessScope, q: VersionQuery): Promise<ScoredChunk[]> {
    if (!scope || !Array.isArray(scope.groups) || scope.groups.length === 0) {
      throw new MissingScopeError();
    }
    if (q.documentIds.length === 0 || q.perVersion < 1) return [];

    return this.db.transaction(async (client) => {
      await this.assertIndexMatches(client);
      const { rows } = await client.query<ChunkRow>(VERSIONS_SQL, [
        pgvector.toSql(q.embedding),
        q.documentIds,
        scope.groups,
        q.includeStatuses ?? ["current"],
        0,
        q.skipVersions,
        q.perVersion,
        resolveAsOf(q.asOf),
      ]);
      return rows.map((row) => this.toScoredChunk(row));
    });
  }

  private toScoredChunk(row: ChunkRow): ScoredChunk {
    return {
      chunkId: row.chunk_id,
      text: row.text,
      score: Number(row.score),
      cosine: row.cosine === null ? null : Number(row.cosine),
      source: {
        documentId: row.document_id,
        version: row.version,
        title: row.title,
        sourcePath: row.source_path,
        sectionPath: row.section_path,
        pageStart: row.page_start ?? undefined,
        pageEnd: row.page_end ?? undefined,
        charStart: row.char_start,
        charEnd: row.char_end,
        chunkIndex: row.chunk_index,
      },
      tier: row.tier,
      authorityRank: row.authority_rank,
      level: row.level,
      classification: row.classification,
      status: row.status,
      trust: row.trust,
      effectiveFrom: toDateString(row.effective_from),
      owner: row.owner,
      relations: row.relations ?? [],
    };
  }

  private async assertIndexMatches(client: pg.PoolClient): Promise<void> {
    const { rows } = await client.query<{
      embedding_model: string;
      dim: number;
      prefix_scheme: string;
    }>("SELECT embedding_model, dim, prefix_scheme FROM index_meta WHERE id = true");

    // An empty index has nothing to disagree with.
    if (rows.length === 0) return;

    const actual: IndexInfo = {
      embeddingModel: rows[0]!.embedding_model,
      dim: rows[0]!.dim,
      prefixScheme: rows[0]!.prefix_scheme,
    };
    const expected: IndexInfo = {
      embeddingModel: this.embeddings.modelId,
      dim: this.embeddings.dim,
      prefixScheme: this.embeddings.prefixScheme,
    };

    if (
      actual.embeddingModel !== expected.embeddingModel ||
      actual.dim !== expected.dim ||
      actual.prefixScheme !== expected.prefixScheme
    ) {
      throw new IndexMismatchError(expected, actual);
    }
  }

  // --- writes -------------------------------------------------------------

  /**
   * Upserts the document row and all of its chunks in one transaction, so a
   * reader never sees a document whose chunks disagree with it.
   * Caller passes every chunk of exactly one (documentId, version).
   */
  async upsert(chunks: ChunkRecord[]): Promise<void> {
    if (chunks.length === 0) return;

    const first = chunks[0]!;
    const { documentId, version } = first.source;
    const mismatched = chunks.find(
      (c) => c.source.documentId !== documentId || c.source.version !== version,
    );
    if (mismatched) {
      throw new Error(
        `upsert expects chunks of one document version, got ${documentId} v${version} and ` +
          `${mismatched.source.documentId} v${mismatched.source.version}.`,
      );
    }

    await this.db.transaction(async (client) => {
      await client.query(
        `INSERT INTO documents (
           document_id, version, title, source_path, content_sha256,
           allowed_groups, classification, classification_groups, deny_groups,
           tier, authority_rank, level, owner, relations,
           status, raw_status, effective_from, trust
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18)
         ON CONFLICT (document_id, version) DO UPDATE SET
           title = EXCLUDED.title,
           source_path = EXCLUDED.source_path,
           content_sha256 = EXCLUDED.content_sha256,
           allowed_groups = EXCLUDED.allowed_groups,
           classification = EXCLUDED.classification,
           classification_groups = EXCLUDED.classification_groups,
           deny_groups = EXCLUDED.deny_groups,
           tier = EXCLUDED.tier,
           authority_rank = EXCLUDED.authority_rank,
           level = EXCLUDED.level,
           owner = EXCLUDED.owner,
           relations = EXCLUDED.relations,
           status = EXCLUDED.status,
           raw_status = EXCLUDED.raw_status,
           effective_from = EXCLUDED.effective_from,
           trust = EXCLUDED.trust`,
        // Deliberately not touching deleted_at/by/reason or created_at:
        // re-ingest must not resurrect a soft-deleted document.
        [
          documentId,
          version,
          first.source.title,
          first.source.sourcePath,
          first.contentSha256,
          first.allowedGroups,
          first.classification,
          first.classificationGroups,
          first.denyGroups,
          first.tier,
          first.authorityRank,
          first.level,
          first.owner,
          JSON.stringify(first.relations),
          first.status,
          first.rawStatus,
          first.effectiveFrom,
          first.trust,
        ],
      );

      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO chunks (
             chunk_id, document_id, version, chunk_index,
             title, source_path, section_path, page_start, page_end, char_start, char_end,
             text, embedding,
             allowed_groups, classification, classification_groups, deny_groups,
             tier, authority_rank, level, status, effective_from, trust
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
           ON CONFLICT (chunk_id) DO UPDATE SET
             chunk_index = EXCLUDED.chunk_index,
             title = EXCLUDED.title,
             source_path = EXCLUDED.source_path,
             section_path = EXCLUDED.section_path,
             page_start = EXCLUDED.page_start,
             page_end = EXCLUDED.page_end,
             char_start = EXCLUDED.char_start,
             char_end = EXCLUDED.char_end,
             text = EXCLUDED.text,
             embedding = EXCLUDED.embedding,
             allowed_groups = EXCLUDED.allowed_groups,
             classification = EXCLUDED.classification,
             classification_groups = EXCLUDED.classification_groups,
             deny_groups = EXCLUDED.deny_groups,
             tier = EXCLUDED.tier,
             authority_rank = EXCLUDED.authority_rank,
             level = EXCLUDED.level,
             status = EXCLUDED.status,
             effective_from = EXCLUDED.effective_from,
             trust = EXCLUDED.trust`,
          [
            chunk.chunkId,
            chunk.source.documentId,
            chunk.source.version,
            chunk.source.chunkIndex,
            chunk.source.title,
            chunk.source.sourcePath,
            chunk.source.sectionPath,
            chunk.source.pageStart ?? null,
            chunk.source.pageEnd ?? null,
            chunk.source.charStart,
            chunk.source.charEnd,
            chunk.text,
            pgvector.toSql(chunk.embedding),
            chunk.allowedGroups,
            chunk.classification,
            chunk.classificationGroups,
            chunk.denyGroups,
            chunk.tier,
            chunk.authorityRank,
            chunk.level,
            chunk.status,
            chunk.effectiveFrom,
            chunk.trust,
          ],
        );
      }

      // A re-chunk that produced fewer or differently numbered chunks must not
      // leave orphans behind. Matching on the ids actually written is correct
      // whatever the chunk indices are; assuming they run 0..n-1 is not.
      await client.query(
        `DELETE FROM chunks
         WHERE document_id = $1 AND version = $2 AND chunk_id <> ALL ($3::text[])`,
        [documentId, version, chunks.map((c) => c.chunkId)],
      );
    });
  }

  // --- lifecycle ----------------------------------------------------------

  /**
   * Soft delete covers every version of the document, and every chunk, in one
   * transaction. The search filter excludes them from that point on.
   */
  async softDeleteDoc(documentId: string, by: string, reason: string, at: Date): Promise<void> {
    await this.db.transaction(async (client) => {
      await client.query(
        `UPDATE documents SET deleted_at = $2, deleted_by = $3, delete_reason = $4
         WHERE document_id = $1`,
        [documentId, at, by, reason],
      );
      await client.query(`UPDATE chunks SET deleted_at = $2 WHERE document_id = $1`, [
        documentId,
        at,
      ]);
    });
  }

  async restoreDoc(documentId: string, by: string): Promise<void> {
    await this.db.transaction(async (client) => {
      await client.query(
        `UPDATE documents
         SET deleted_at = NULL, deleted_by = NULL, delete_reason = $2
         WHERE document_id = $1`,
        [documentId, `restored by ${by}`],
      );
      await client.query(`UPDATE chunks SET deleted_at = NULL WHERE document_id = $1`, [documentId]);
    });
  }

  async setDocStatus(documentId: string, version: string, status: Status): Promise<void> {
    await this.db.transaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE documents SET status = $3 WHERE document_id = $1 AND version = $2`,
        [documentId, version, status],
      );
      if (rowCount === 0) {
        throw new Error(`No such document: ${documentId} v${version}`);
      }
      await client.query(
        `UPDATE chunks SET status = $3 WHERE document_id = $1 AND version = $2`,
        [documentId, version, status],
      );
    });
  }

  /** Permission change must land on the document and its chunks together, or not at all. */
  async setDocPermissions(documentId: string, perms: Permissions): Promise<void> {
    await this.db.transaction(async (client) => {
      const args = [
        documentId,
        perms.allowedGroups,
        perms.classification,
        perms.classificationGroups,
        perms.denyGroups,
      ];
      const { rowCount } = await client.query(
        `UPDATE documents
         SET allowed_groups = $2, classification = $3, classification_groups = $4, deny_groups = $5
         WHERE document_id = $1`,
        args,
      );
      if (rowCount === 0) {
        throw new Error(`No such document: ${documentId}`);
      }
      await client.query(
        `UPDATE chunks
         SET allowed_groups = $2, classification = $3, classification_groups = $4, deny_groups = $5
         WHERE document_id = $1`,
        args,
      );
    });
  }

  async purgeDeleted(olderThan: Date): Promise<number> {
    return this.db.transaction(async (client) => {
      // Chunks go with the document through ON DELETE CASCADE.
      const { rowCount } = await client.query(
        `DELETE FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < $1`,
        [olderThan],
      );
      return rowCount ?? 0;
    });
  }

  // --- index metadata -----------------------------------------------------

  async documentHash(documentId: string, version: string): Promise<string | null> {
    const { rows } = await this.db.query<{ content_sha256: string }>(
      "SELECT content_sha256 FROM documents WHERE document_id = $1 AND version = $2",
      [documentId, version],
    );
    return rows[0]?.content_sha256 ?? null;
  }

  async indexInfo(): Promise<IndexInfo | null> {
    const { rows } = await this.db.query<{
      embedding_model: string;
      dim: number;
      prefix_scheme: string;
    }>("SELECT embedding_model, dim, prefix_scheme FROM index_meta WHERE id = true");
    if (rows.length === 0) return null;
    return {
      embeddingModel: rows[0]!.embedding_model,
      dim: rows[0]!.dim,
      prefixScheme: rows[0]!.prefix_scheme,
    };
  }

  async setIndexInfo(info: IndexInfo): Promise<void> {
    await this.db.query(
      `INSERT INTO index_meta (id, embedding_model, dim, prefix_scheme)
       VALUES (true, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         embedding_model = EXCLUDED.embedding_model,
         dim = EXCLUDED.dim,
         prefix_scheme = EXCLUDED.prefix_scheme`,
      [info.embeddingModel, info.dim, info.prefixScheme],
    );
  }
}
