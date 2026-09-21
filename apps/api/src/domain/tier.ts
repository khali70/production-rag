import type { Tier } from "./types.js";

/**
 * Authority rank per tier. Higher wins.
 * Rank describes the KIND of document; `level` describes how high in the
 * organisation it was issued. Conflicts compare level first, then rank.
 */
export const TIER_RANK: Readonly<Record<Tier, number>> = Object.freeze({
  policy: 100,
  delegated_standard: 90,
  advisory: 70,
  record: 50,
  unverified: 10,
});

export const TIERS = Object.keys(TIER_RANK) as Tier[];

export function rankOf(tier: Tier): number {
  return TIER_RANK[tier];
}

/** A tier that may never define company rules or act on another document. */
export function isAuthoritative(tier: Tier): boolean {
  return tier !== "unverified" && tier !== "record";
}
