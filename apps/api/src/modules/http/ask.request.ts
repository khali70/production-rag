import { z } from "zod";
import type { AskOptions } from "../answer/answer.service.js";

/**
 * Body of POST /api/ask. Mirrors the flags of the ask CLI, with the same
 * defaults, so a question asked from the page and from the terminal behaves
 * identically. The caller names a user id only: groups are always resolved
 * server-side from identities.json, never taken from the request.
 */
/** Search pool the reranker scores. */
export const RERANK_POOL = 8;
/**
 * Reranker score below which a chunk is off-topic. bge-reranker-v2-m3 scores
 * real answers as low as 0.0075 on the pack's test questions, so the cosine
 * gate (0.40) does the off-topic work and this only drops clear noise.
 */
export const RERANK_MIN_SCORE = 0.005;

export const AskRequestSchema = z.strictObject({
  userId: z.string().min(1),
  question: z.string().trim().min(1).max(2000),
  // retrieval: rerank the pool, keep the top k, return the best chunk. No LLM.
  mode: z.enum(["retrieval", "llm"]).default("retrieval"),
  k: z.number().int().min(1).max(50).default(3),
  order: z.enum(["relevance", "precedence"]).default("precedence"),
  // Every status by default: old versions reach the prompt marked as old, so
  // the model can say what changed instead of never seeing it.
  statuses: z.array(z.enum(["current", "superseded", "retired"])).min(1).default(["current", "superseded", "retired"]),
  minCosine: z.number().min(-1).max(1).nullable().default(null),
  gateCosine: z.number().min(-1).max(1).default(0.4),
  cosineMargin: z.number().min(0).max(2).default(0.25),
  asOf: z.iso.date().nullable().default(null),
  maxContextChars: z.number().int().min(500).max(100_000).default(12_000),
  versionChunks: z.number().int().min(0).max(10).default(2),
  relatedChunks: z.number().int().min(0).max(10).default(1),
  // On by default: search fetches `pool` chunks by relevance, the reranker keeps the best k.
  rerank: z
    .strictObject({
      pool: z.number().int().min(1).max(100).default(RERANK_POOL),
      minScore: z.number().min(0).max(1).default(RERANK_MIN_SCORE),
    })
    .nullable()
    .default({ pool: RERANK_POOL, minScore: RERANK_MIN_SCORE }),
});

export type AskRequest = z.infer<typeof AskRequestSchema>;

export function toAskOptions(req: AskRequest): AskOptions {
  if (req.rerank && req.rerank.pool < req.k) {
    throw new z.ZodError([
      { code: "custom", path: ["rerank", "pool"], message: `rerank.pool (${req.rerank.pool}) must be >= k (${req.k})`, input: req.rerank.pool },
    ]);
  }
  return {
    mode: req.mode,
    topK: req.k,
    includeStatuses: req.statuses,
    minCosine: req.minCosine ?? undefined,
    asOf: req.asOf ?? undefined,
    orderBy: req.order,
    gateCosine: req.gateCosine,
    relativeCosineMargin: req.cosineMargin,
    maxContextChars: req.maxContextChars,
    versionChunks: req.versionChunks,
    relatedChunks: req.relatedChunks,
    rerank: req.rerank ?? undefined,
  };
}
