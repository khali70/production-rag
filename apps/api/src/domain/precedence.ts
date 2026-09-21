import type { ScoredChunk } from "./types.js";
import { TIER_RANK } from "./tier.js";

/**
 * Conflict precedence, applied after permissions and lifecycle have already
 * removed everything the caller may not see or that is not current.
 *
 * Order:
 *   1. unverified always last. An unverified document is never authoritative,
 *      whatever level it claims, so it can never win on the level comparison.
 *   2. level ASC   - higher management wins (0 = company-wide).
 *   3. rank  DESC  - policy beats delegated standard beats advisory beats record.
 *   4. effectiveFrom DESC - newer wins.
 *   5. score DESC, then chunkId, so the order is total and stable.
 *
 * Relations (supersedes / amends / qualifies) are applied by the caller BEFORE
 * this comparator runs: they decide which documents are in play at all.
 */
export function comparePrecedence(a: ScoredChunk, b: ScoredChunk): number {
  const aUnverified = a.tier === "unverified" ? 1 : 0;
  const bUnverified = b.tier === "unverified" ? 1 : 0;
  if (aUnverified !== bUnverified) return aUnverified - bUnverified;

  if (a.level !== b.level) return a.level - b.level;

  const aRank = a.authorityRank ?? TIER_RANK[a.tier];
  const bRank = b.authorityRank ?? TIER_RANK[b.tier];
  if (aRank !== bRank) return bRank - aRank;

  if (a.effectiveFrom !== b.effectiveFrom) {
    return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
  }

  if (a.score !== b.score) return b.score - a.score;
  return a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0;
}

/**
 * True when `candidate` may not override `incumbent` because it sits lower in
 * the management hierarchy. Used by the later retrieval layer to explain a
 * dropped conflict, and by the contract tests.
 */
export function isOutrankedByLevel(candidate: ScoredChunk, incumbent: ScoredChunk): boolean {
  return candidate.level > incumbent.level;
}
