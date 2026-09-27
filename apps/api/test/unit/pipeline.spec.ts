import { describe, expect, it } from "vitest";
import { FakeEmbeddingAdapter } from "../../src/adapters/embedding/fake-embedding.adapter.js";
import { FakeLlm } from "../../src/adapters/llm/fake-llm.adapter.js";
import { FakeReranker } from "../../src/adapters/reranker/fake-reranker.adapter.js";
import { rankOf } from "../../src/domain/tier.js";
import type { AccessScope, ScoredChunk, SearchQuery, VersionQuery } from "../../src/domain/types.js";
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
  mode: "llm",
  topK: 2,
  orderBy: "precedence",
  gateCosine: 0.5,
  relativeCosineMargin: 0.15,
  maxContextChars: 12000,
  versionChunks: 0,
  relatedChunks: 0,
  ...over,
});

function build(chunks: ScoredChunk[], related: ScoredChunk[] = []) {
  const queries: SearchQuery[] = [];
  const store = {
    search: async (_: AccessScope, q: SearchQuery) => (queries.push(q), chunks.slice(0, q.topK)),
    versions: async () => [],
    related: async () => related,
  };
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

describe("retrieval mode", () => {
  const retrieval = (over: Partial<AskOptions> = {}) => opts({ mode: "retrieval", rerank: { pool: 3, minScore: 0.5 }, ...over });

  it("returns the reranker's best chunk verbatim and never calls the LLM", async () => {
    const { service, llm } = build(pool);
    const { answer, debug } = await service.ask(scope, "vendor approval", retrieval());

    expect(llm.calls).toHaveLength(0);
    expect(debug.best!.source.documentId).toBe("VENDOR");
    expect(answer.status).toBe("answered");
    expect(answer.text).toBe("vendor approval requires procurement sign off");
    expect(answer.match).toMatchObject({ chunkId: "VENDOR@1.0#0", rerankScore: 1, cosine: 0.7, role: "primary" });
    expect(answer.sources.map((s) => s.source.documentId)).toEqual(["VENDOR"]);
  });

  it("qualifies a best match that is not the rule in force", async () => {
    const old = { ...chunk("VENDOR", "vendor approval requires CFO sign off", 0.7), status: "superseded" as const };
    const { service } = build([old]);
    const { answer } = await service.ask(scope, "vendor approval", retrieval());
    expect(answer.status).toBe("qualified");
    expect(answer.warnings.join()).toMatch(/superseded version/);
  });

  it("prefers a current version over a higher-ranked old one, unless the question asks about the past", async () => {
    const old = { ...chunk("POL", "vendor approval threshold is 100,000", 0.8), chunkId: "POL@0.9#0", status: "retired" as const };
    const current = chunk("POL", "the vendor approval threshold is 50,000 and applies from July", 0.7);
    const { service } = build([old, current]);

    const now = await service.ask(scope, "vendor approval threshold", retrieval({ rerank: { pool: 2, minScore: 0 } }));
    expect(now.answer.match!.chunkId).toBe("POL@1.0#0");
    expect(now.debug.bestReason).toMatch(/first current version/);

    const then = await service.ask(scope, "what was vendor approval threshold before", retrieval({ rerank: { pool: 2, minScore: 0 } }));
    expect(then.answer.match!.chunkId).toBe("POL@0.9#0");
    expect(then.answer.status).toBe("qualified");
  });

  it("appends a current document that amends the best match, and nothing else related", async () => {
    const matrix = {
      ...chunk("MTX", "below 50,000: budget owner. 50,000 to 249,999: VP and Finance Controller", 0.4),
      relations: [{ kind: "amends" as const, documentId: "VENDOR", version: "1.0", scope: "financial approval thresholds" }],
    };
    const memo = {
      ...chunk("MEMO", "renewals below 100,000 may use the standard template", 0.4),
      relations: [{ kind: "qualifies" as const, documentId: "VENDOR", version: "1.0", scope: "legal review" }],
    };
    const { service } = build(pool, [matrix, memo]);

    const { answer, debug } = await service.ask(scope, "vendor approval", retrieval({ relatedChunks: 1 }));

    expect(answer.match!.chunkId).toBe("VENDOR@1.0#0");
    expect(answer.amendments).toEqual([expect.objectContaining({ chunkId: "MTX@1.0#0", scope: "financial approval thresholds", rerankScore: null })]);
    expect(answer.text).toBe(
      'vendor approval requires procurement sign off\n\nAmended by MTX v1.0 "MTX" (financial approval thresholds):\nbelow 50,000: budget owner. 50,000 to 249,999: VP and Finance Controller',
    );
    expect(answer.sources.map((s) => s.source.documentId)).toEqual(["VENDOR", "MTX"]);
    expect(answer.status).toBe("answered");
    expect(debug.related.chunks.map((c) => c.source.documentId)).toEqual(["MTX"]);
  });

  it("appends nothing when related documents are turned off", async () => {
    const matrix = { ...chunk("MTX", "thresholds", 0.4), relations: [{ kind: "amends" as const, documentId: "VENDOR", version: "1.0", scope: "thresholds" }] };
    const { service } = build(pool, [matrix]);
    const { answer } = await service.ask(scope, "vendor approval", retrieval({ relatedChunks: 0 }));
    expect(answer.amendments).toBeUndefined();
    expect(answer.text).toBe("vendor approval requires procurement sign off");
  });

  it("returns no chunk when every reranked chunk is below the floor", async () => {
    const { service, llm } = build(pool);
    const { answer, debug } = await service.ask(scope, "holiday rota", retrieval());
    expect(answer.status).toBe("refused");
    expect(answer.match).toBeUndefined();
    expect(answer.sources).toEqual([]);
    expect(debug.best).toBeUndefined();
    expect(llm.calls).toHaveLength(0);
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

describe("other versions of the files found", () => {
  it("fetches the other versions of every document found and sends them marked old", async () => {
    const current = { ...chunk("POL", "Procurement approves vendors.", 0.7), effectiveFrom: "2026-07-01" };
    const retired: ScoredChunk = {
      ...chunk("POL", "The CFO approved vendors.", 0.2),
      chunkId: "POL@0.9#0",
      status: "retired",
      source: { ...current.source, version: "0.9" },
    };
    const versionQueries: VersionQuery[] = [];
    const store = {
      search: async () => [current],
      versions: async (_: AccessScope, q: VersionQuery) => (versionQueries.push(q), [retired]),
    };
    const llm = new FakeLlm(() => "Procurement approves vendors.");
    const service = new AnswerService(
      new EmbedStage(new FakeEmbeddingAdapter()),
      new SearchStage(store as unknown as VectorStorePort),
      new RerankStage(new FakeReranker()),
      new GenerateStage(llm),
    );

    const { debug } = await service.ask(scope, "who approves vendors", opts({ versionChunks: 2 }));

    expect(versionQueries[0]).toMatchObject({ documentIds: ["POL"], skipVersions: ["POL@1.0"], perVersion: 2 });
    expect(debug.evidence.map((d) => [d.version, d.role, d.priority])).toEqual([["1.0", "primary", 1], ["0.9", "historical", 2]]);
    const prompt = llm.calls[0]!.messages[0]!.content;
    expect(prompt).toContain('v="0.9" state="old"');
    expect(prompt).toContain("The CFO approved vendors.");
  });

  it("adds documents related to the ones found, then their other versions too", async () => {
    const policy = chunk("POL", "Procurement approves vendors.", 0.7);
    const matrix: ScoredChunk = {
      ...chunk("MTX", "Below USD 50,000 the budget owner approves.", 0.1),
      relations: [{ kind: "amends", documentId: "POL", version: "1.0", scope: "thresholds" }],
    };
    const relatedQueries: VersionQuery[] = [];
    const versionQueries: VersionQuery[] = [];
    const store = {
      search: async () => [policy],
      related: async (_: AccessScope, q: VersionQuery) => (relatedQueries.push(q), [matrix]),
      versions: async (_: AccessScope, q: VersionQuery) => (versionQueries.push(q), []),
    };
    const service = new AnswerService(
      new EmbedStage(new FakeEmbeddingAdapter()),
      new SearchStage(store as unknown as VectorStorePort),
      new RerankStage(new FakeReranker()),
      new GenerateStage(new FakeLlm(() => "Budget owner.")),
    );

    const { debug } = await service.ask(scope, "who approves 40k", opts({ relatedChunks: 1, versionChunks: 2 }));

    expect(relatedQueries[0]).toMatchObject({ documentIds: ["POL"], skipVersions: ["POL@1.0"], perVersion: 1 });
    expect(versionQueries[0]).toMatchObject({ documentIds: ["POL", "MTX"], skipVersions: ["POL@1.0", "MTX@1.0"] });
    expect(debug.evidence.map((d) => [d.documentId, d.role])).toEqual([["POL", "primary"], ["MTX", "modifier"]]);
  });

  it("skips the lookup when versionChunks is 0", async () => {
    const { service, queries } = build(pool);
    const { debug } = await service.ask(scope, "vendor approval", opts());
    expect(queries).toHaveLength(1);
    expect(debug.versions.chunks).toEqual([]);
  });
});
