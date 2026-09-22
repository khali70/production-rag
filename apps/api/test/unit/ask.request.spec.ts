import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AskRequestSchema, RERANK_MIN_SCORE, toAskOptions } from "../../src/modules/http/ask.request.js";

describe("AskRequestSchema", () => {
  it("fills the same defaults as the ask CLI", () => {
    const req = AskRequestSchema.parse({ userId: "u-1", question: "  who approves vendors?  " });
    expect(req.question).toBe("who approves vendors?");
    expect(toAskOptions(req)).toEqual({
      mode: "retrieval",
      topK: 3,
      includeStatuses: ["current", "superseded", "retired"],
      minCosine: undefined,
      asOf: undefined,
      orderBy: "precedence",
      gateCosine: 0.4,
      relativeCosineMargin: 0.25,
      maxContextChars: 12_000,
      versionChunks: 2,
      relatedChunks: 1,
      rerank: { pool: 8, minScore: RERANK_MIN_SCORE },
    });
  });

  it("turns reranking off with rerank: null", () => {
    const req = AskRequestSchema.parse({ userId: "u-1", question: "q", mode: "llm", k: 8, rerank: null });
    expect(toAskOptions(req)).toMatchObject({ mode: "llm", topK: 8, rerank: undefined });
  });

  it("maps every field when set", () => {
    const req = AskRequestSchema.parse({
      userId: "u-1",
      question: "q",
      k: 5,
      order: "relevance",
      statuses: ["current", "superseded"],
      minCosine: 0.2,
      gateCosine: 0.35,
      cosineMargin: 0.1,
      asOf: "2026-06-01",
      maxContextChars: 8000,
      rerank: { pool: 20, minScore: 0.2 },
    });
    expect(toAskOptions(req)).toMatchObject({
      topK: 5,
      orderBy: "relevance",
      includeStatuses: ["current", "superseded"],
      minCosine: 0.2,
      asOf: "2026-06-01",
      rerank: { pool: 20, minScore: 0.2 },
    });
  });

  it("rejects groups in the body: identity is resolved server-side", () => {
    expect(() => AskRequestSchema.parse({ userId: "u-1", question: "q", groups: ["hr_admin"] })).toThrow(z.ZodError);
  });

  it.each([
    { k: 0 },
    { gateCosine: 1.5 },
    { statuses: [] },
    { statuses: ["deleted"] },
    { asOf: "June 1st" },
    { question: "   " },
  ])("rejects invalid input %o", (patch) => {
    expect(() => AskRequestSchema.parse({ userId: "u-1", question: "q", ...patch })).toThrow(z.ZodError);
  });

  it("rejects a rerank pool smaller than k", () => {
    const req = AskRequestSchema.parse({ userId: "u-1", question: "q", k: 8, rerank: { pool: 5 } });
    expect(() => toAskOptions(req)).toThrow(/rerank.pool/);
  });
});
