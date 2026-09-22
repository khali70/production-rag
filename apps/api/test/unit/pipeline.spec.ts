import { describe, expect, it } from "vitest";
import { FakeEmbeddingAdapter } from "../../src/adapters/embedding/fake-embedding.adapter.js";
import { FakeLlm } from "../../src/adapters/llm/fake-llm.adapter.js";
import { FakeReranker } from "../../src/adapters/reranker/fake-reranker.adapter.js";
import { rankOf } from "../../src/domain/tier.js";
import type { AccessScope, ScoredChunk, SearchQuery } from "../../src/domain/types.js";
import { AnswerService, type AskOptions } from "../../src/modules/answer/answer.service.js";
import { EmbedStage } from "../../src/modules/answer/stages/embed.stage.js";
import { GenerateStage } from "../../src/modules/answer/stages/generate.stage.js";
import { RerankStage } from "../../src/modules/answer/stages/rerank.stage.js";
import { SearchStage } from "../../src/modules/answer/stages/search.stage.js";
import type { VectorStorePort } from "../../src/ports/vector-store.port.js";

function chunk(documentId: string, text: string, cosine: number): ScoredChunk {
  return {
    chunkId: `${documentId}@1.0#0`,
    text,
    score: cosine,
    cosine,
    source: {
      documentId,
      version: "1.0",
      title: documentId,
      sourcePath: `corpus/${documentId}`,
      sectionPath: ["Document"],
      charStart: 0,
      charEnd: text.length,
      chunkIndex: 0,
    },
    tier: "policy",
    authorityRank: rankOf("policy"),
    level: 1,
    classification: "INTERNAL",
    status: "current",
    trust: "normal",
    effectiveFrom: "2026-01-01",
    owner: "owner",
    relations: [],
  };
}

const scope: AccessScope = { principalId: "u-1", groups: ["g"], department: "ops" };

const opts = (over: Partial<AskOptions> = {}): AskOptions => ({
  topK: 2,
  orderBy: "precedence",
  gateCosine: 0.5,
  relativeCosineMargin: 0.15,
  maxContextChars: 12000,
  ...over,
});

function build(chunks: ScoredChunk[]) {
  const queries: SearchQuery[] = [];
  const store = { search: async (_: AccessScope, q: SearchQuery) => (queries.push(q), chunks.slice(0, q.topK)) };
  const llm = new FakeLlm();
  const service = new AnswerService(
    new EmbedStage(new FakeEmbeddingAdapter()),
    new SearchStage(store as unknown as VectorStorePort),
    new RerankStage(new FakeReranker()),
    new GenerateStage(llm),
  );
  return { service, queries, llm };
}

// Cosine favours the off-topic chunks; the reranker favours the one that answers.
const pool = [
  chunk("OFF-A", "office plants watering schedule", 0.8),
  chunk("OFF-B", "parking permits for staff", 0.78),
  chunk("VENDOR", "vendor approval requires procurement sign off", 0.7),
];

describe("answer pipeline", () => {
  it("without rerank, searches topK in the requested order and never scores", async () => {
    const { service, queries } = build(pool);
    const { debug } = await service.ask(scope, "vendor approval", opts());
    expect(queries[0]).toMatchObject({ topK: 2, orderBy: "precedence" });
    expect(debug.rerank).toBeUndefined();
  });

  it("with rerank, fetches the wider pool by relevance and passes the reranked chunks on to the LLM", async () => {
    const { service, queries, llm } = build(pool);
    const { debug } = await service.ask(scope, "vendor approval", opts({ rerank: { pool: 3, minScore: 0.5 } }));

    expect(queries[0]).toMatchObject({ topK: 3, orderBy: "relevance" });
    expect(debug.rerank!.kept.map((c) => c.source.documentId)[0]).toBe("VENDOR");
    expect(debug.offTopic.map((c) => c.source.documentId)).toEqual(["OFF-A"]);
    expect(debug.evidence.map((d) => d.documentId)).toEqual(["VENDOR"]);
    expect(llm.calls[0]!.messages[0]!.content).toContain("procurement sign off");
    expect(llm.calls[0]!.messages[0]!.content).not.toContain("office plants");
  });

  it("refuses without calling the LLM when every reranked chunk is below the floor", async () => {
    const { service, llm } = build(pool);
    const { answer, debug } = await service.ask(scope, "holiday rota", opts({ rerank: { pool: 3, minScore: 0.5 } }));
    expect(answer.status).toBe("refused");
    expect(debug.gate).toMatch(/below 0.5/);
    expect(llm.calls).toHaveLength(0);
  });

  it("rejects a rerank pool smaller than topK", async () => {
    const { service } = build(pool);
    await expect(service.ask(scope, "q", opts({ rerank: { pool: 1, minScore: 0 } }))).rejects.toThrow(/pool/);
  });
});

describe("plain-text answers", () => {
  it("asks for text, not JSON, and returns the reply with the sources appended", async () => {
    const chunks = [chunk("VENDOR", "vendor approval requires procurement sign off", 0.7)];
    const store = { search: async () => chunks };
    const llm = new FakeLlm(() => "Procurement signs off on vendor approval.");
    const service = new AnswerService(
      new EmbedStage(new FakeEmbeddingAdapter()),
      new SearchStage(store as unknown as VectorStorePort),
      new RerankStage(new FakeReranker()),
      new GenerateStage(llm),
    );

    const { answer } = await service.ask(scope, "vendor approval", opts());

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]).not.toHaveProperty("jsonSchema");
    expect(answer.status).toBe("answered");
    expect(answer.message).toBe(
      "Procurement signs off on vendor approval.\n\nSources:\n[C1] VENDOR (VENDOR v1.0, Document) - primary",
    );
  });
});
