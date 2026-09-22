/**
 * Hybrid retrieval SQL: dense vector leg + Postgres full-text leg, fused with
 * Reciprocal Rank Fusion, with the access filter applied inside both legs.
 *
 * Two deliberate choices:
 *
 * 1. ACL_WHERE is one string interpolated into both legs, so the two filters
 *    are identical by construction. A shared CTE would read better but
 *    Postgres materializes a CTE referenced twice, which throws away the HNSW
 *    index. This string contains no user input: only parameter placeholders.
 *
 * 2. The full-text leg ORs the query lexemes. websearch_to_tsquery ANDs every
 *    term, so a natural-language question ("what is our process for approving
 *    a new enterprise vendor?") matches nothing at all.
 */

/**
 * $3 user groups, $4 statuses, $5 min authority rank, $8 as-of date.
 * Soft-deleted rows are excluded here, not by callers, so no code path can
 * forget. Default is deny: all three permission checks must pass.
 * A document approved but not yet effective is not guidance today, so
 * effective_from is checked against the as-of date regardless of status.
 */
export const ACL_WHERE = `
      c.deleted_at IS NULL
  AND c.allowed_groups        && $3::text[]
  AND c.classification_groups && $3::text[]
  AND NOT (c.deny_groups      && $3::text[])
  AND c.status = ANY ($4::text[])
  AND c.authority_rank >= $5
  AND c.effective_from <= $8::date`;

const RETURNED_COLUMNS = `
    c.chunk_id, c.document_id, c.version, c.chunk_index,
    c.title, c.source_path, c.section_path, c.page_start, c.page_end,
    c.char_start, c.char_end, c.text,
    c.classification, c.tier, c.authority_rank, c.level,
    c.status, c.effective_from, c.trust,
    d.owner, d.relations`;

/** Rank by fused relevance; authority only breaks ties. */
const ORDER_RELEVANCE = `
    f.rrf DESC,
    c.level ASC,
    c.authority_rank DESC,
    c.effective_from DESC,
    c.chunk_id ASC`;

/**
 * Rank by authority first, for conflict resolution.
 * The unverified term comes first so an unverified document sitting at a high
 * management level can never outrank a verified one. Level then decides:
 * lower number = higher in the organisation = wins.
 */
const ORDER_PRECEDENCE = `
    (c.tier = 'unverified') ASC,
    c.level ASC,
    c.authority_rank DESC,
    c.effective_from DESC,
    f.rrf DESC,
    c.chunk_id ASC`;

/**
 * $1 query vector, $2 query text, $3 groups, $4 statuses,
 * $5 min authority rank, $6 candidate pool size, $7 topK, $8 as-of date,
 * $9 min cosine or NULL for no threshold.
 *
 * The cosine threshold is checked against the real embedding distance of every
 * fused row, not the vector-leg column, so full-text-only hits are held to it too.
 */
export function buildSearchSql(orderBy: "relevance" | "precedence"): string {
  return `
WITH q AS (
  SELECT to_tsquery(
           'simple',
           string_agg('''' || replace(lexeme, '''', '''''') || '''', ' | ')
         ) AS tsq
  FROM unnest(to_tsvector('english', $2))
),
vec AS (
  SELECT c.chunk_id, c.embedding <=> $1::vector AS dist
  FROM chunks c
  WHERE ${ACL_WHERE}
  ORDER BY c.embedding <=> $1::vector
  LIMIT $6
),
vec_r AS (
  SELECT chunk_id, dist, ROW_NUMBER() OVER (ORDER BY dist ASC, chunk_id ASC) AS r
  FROM vec
),
fts AS (
  SELECT c.chunk_id, ts_rank_cd(c.tsv, q.tsq) AS ft
  FROM chunks c CROSS JOIN q
  WHERE q.tsq IS NOT NULL
    AND c.tsv @@ q.tsq
    AND ${ACL_WHERE}
  ORDER BY ft DESC, c.chunk_id ASC
  LIMIT $6
),
fts_r AS (
  SELECT chunk_id, ft, ROW_NUMBER() OVER (ORDER BY ft DESC, chunk_id ASC) AS r
  FROM fts
),
fused AS (
  SELECT
    COALESCE(v.chunk_id, t.chunk_id) AS chunk_id,
    COALESCE(1.0 / (60 + v.r), 0) + COALESCE(1.0 / (60 + t.r), 0) AS rrf,
    CASE WHEN v.dist IS NULL THEN NULL ELSE 1 - v.dist END AS cosine
  FROM vec_r v
  FULL OUTER JOIN fts_r t ON v.chunk_id = t.chunk_id
)
SELECT ${RETURNED_COLUMNS}, f.rrf AS score, f.cosine
FROM fused f
JOIN chunks c ON c.chunk_id = f.chunk_id
JOIN documents d ON d.document_id = c.document_id AND d.version = c.version
WHERE $9::float8 IS NULL OR 1 - (c.embedding <=> $1::vector) >= $9::float8
ORDER BY ${orderBy === "precedence" ? ORDER_PRECEDENCE : ORDER_RELEVANCE}
LIMIT $7`;
}

/**
 * Other versions of documents the search already found: the best `perVersion`
 * chunks of every (document_id, version) not already in the result, by vector
 * distance to the question. Same ACL_WHERE as the search, so an old version
 * the user may not see stays invisible.
 *
 * $1 query vector, $2 document ids, $3 groups, $4 statuses, $5 min authority
 * rank, $6 "documentId@version" keys to skip, $7 perVersion, $8 as-of date.
 */
export const VERSIONS_SQL = `
SELECT *
FROM (
  SELECT ${RETURNED_COLUMNS},
         0 AS score,
         1 - (c.embedding <=> $1::vector) AS cosine,
         ROW_NUMBER() OVER (
           PARTITION BY c.document_id, c.version
           ORDER BY c.embedding <=> $1::vector, c.chunk_id
         ) AS rn
  FROM chunks c
  JOIN documents d ON d.document_id = c.document_id AND d.version = c.version
  WHERE ${ACL_WHERE}
    AND c.document_id = ANY ($2::text[])
    AND NOT ((c.document_id || '@' || c.version) = ANY ($6::text[]))
) v
WHERE v.rn <= $7
ORDER BY v.document_id, v.effective_from DESC, v.chunk_index`;
