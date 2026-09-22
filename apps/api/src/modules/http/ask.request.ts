import { z } from "zod";
import type { AskOptions } from "../answer/answer.service.js";

/**
 * Body of POST /api/ask. Mirrors the flags of the ask CLI, with the same
 * defaults, so a question asked from the page and from the terminal behaves
 * identically. The caller names a user id only: groups are always resolved
 * server-side from identities.json, never taken from the request.
 */
export const AskRequestSchema = z.strictObject({
  userId: z.string().min(1),
  question: z.string().trim().min(1).max(2000),
  k: z.number().int().min(1).max(50).default(3),
  order: z.enum(["relevance", "precedence"]).default("precedence"),
  // Every status by default: old versions reach the prompt marked as old, so
  // the model can say what changed instead of never seeing it.
  statuses: z.array(z.enum(["current", "superseded", "retired"])).min(1).default(["current", "superseded", "retired"]),
  minCosine: z.number().min(-1).max(1).nullable().default(null),
  gateCosine: z.number().min(-1).max(1).default(0.3),
  cosineMargin: z.number().min(0).max(2).default(0.15),
  asOf: z.iso.date().nullable().default(null),
  maxContextChars: z.number().int().min(500).max(100_000).default(12_000),
  versionChunks: z.number().int().min(0).max(10).default(2),
  rerank: z
    .strictObject({
      pool: z.number().int().min(1).max(100).default(5),
      minScore: z.number().min(0).max(1).default(0.1),
    })
    .nullable()
    .default(null),
});

export type AskRequest = z.infer<typeof AskRequestSchema>;

export function toAskOptions(req: AskRequest): AskOptions {
  if (req.rerank && req.rerank.pool < req.k) {
    throw new z.ZodError([
      { code: "custom", path: ["rerank", "pool"], message: `rerank.pool (${req.rerank.pool}) must be >= k (${req.k})`, input: req.rerank.pool },
    ]);
  }
  return {
    topK: req.k,
    includeStatuses: req.statuses,
    minCosine: req.minCosine ?? undefined,
    asOf: req.asOf ?? undefined,
    orderBy: req.order,
    gateCosine: req.gateCosine,
    relativeCosineMargin: req.cosineMargin,
    maxContextChars: req.maxContextChars,
    versionChunks: req.versionChunks,
    rerank: req.rerank ?? undefined,
  };
}
