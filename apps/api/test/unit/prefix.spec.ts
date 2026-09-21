import { describe, expect, it, vi } from "vitest";
import { TransformersEmbeddingAdapter } from "../../src/adapters/embedding/transformers-embedding.adapter.js";
import { AppConfig } from "../../src/config/app-config.js";
import type { Env } from "../../src/config/env.schema.js";

const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

function makeConfig(dim = 384): AppConfig {
  return new AppConfig({
    NODE_ENV: "test",
    PORT: 3001,
    POSTGRES_USER: "rag",
    POSTGRES_PASSWORD: "x",
    POSTGRES_DB: "rag",
    POSTGRES_HOST_PORT: 5435,
    DATABASE_URL: "postgres://localhost/rag",
    TEST_DATABASE_URL: "postgres://localhost/rag_test",
    PACK_DIR: "Kentrick_Assessment_Pack_Candidate",
    AUTHORITY_FILE: "data/authority.yaml",
    EMBEDDING_MODEL_ID: "Xenova/bge-small-en-v1.5",
    EMBEDDING_DIM: dim,
    EMBEDDING_DTYPE: "fp32",
    EMBEDDING_CACHE_DIR: ".cache/models",
    EMBEDDING_ALLOW_REMOTE: false,
    PURGE_RETENTION_DAYS: 30,
  } as Env);
}

/** Records what reached the model, and returns vectors of the requested width. */
function fakeExtractor(dim = 384) {
  const seen: string[][] = [];
  const fn = vi.fn(async (texts: string[]) => {
    seen.push([...texts]);
    return {
      tolist: () => texts.map(() => new Array<number>(dim).fill(0.1)),
      dims: [texts.length, dim],
    };
  });
  return { fn, seen };
}

describe("bge prefix handling", () => {
  it("prefixes a query exactly once", async () => {
    const { fn, seen } = fakeExtractor();
    const adapter = new TransformersEmbeddingAdapter(makeConfig(), fn as never);

    await adapter.embed(["how much leave do I get"], "query");

    expect(seen[0]).toEqual([`${QUERY_PREFIX}how much leave do I get`]);
    const prefixCount = seen[0]![0]!.split(QUERY_PREFIX).length - 1;
    expect(prefixCount).toBe(1);
  });

  it("never prefixes a document", async () => {
    const { fn, seen } = fakeExtractor();
    const adapter = new TransformersEmbeddingAdapter(makeConfig(), fn as never);

    await adapter.embed(["Employees request annual leave."], "document");

    expect(seen[0]).toEqual(["Employees request annual leave."]);
  });

  it("uses CLS pooling with normalization, which is what bge expects", async () => {
    const { fn } = fakeExtractor();
    const adapter = new TransformersEmbeddingAdapter(makeConfig(), fn as never);

    await adapter.embed(["anything"], "document");

    expect(fn).toHaveBeenCalledWith(expect.anything(), { pooling: "cls", normalize: true });
  });

  it("batches long inputs without dropping or reordering any", async () => {
    const { fn, seen } = fakeExtractor();
    const adapter = new TransformersEmbeddingAdapter(makeConfig(), fn as never);
    const texts = Array.from({ length: 35 }, (_, i) => `chunk ${i}`);

    const vectors = await adapter.embed(texts, "document");

    expect(vectors).toHaveLength(35);
    expect(seen.flat()).toEqual(texts);
    expect(fn).toHaveBeenCalledTimes(3); // 16 + 16 + 3
  });

  it("refuses a model whose width disagrees with EMBEDDING_DIM", async () => {
    const { fn } = fakeExtractor(768);
    const adapter = new TransformersEmbeddingAdapter(makeConfig(384), fn as never);

    await expect(adapter.embed(["x"], "document")).rejects.toThrow(/returned dim 768/);
  });

  it("records the prefix convention in the index scheme, so a change is detectable", () => {
    const adapter = new TransformersEmbeddingAdapter(makeConfig(), fakeExtractor().fn as never);
    expect(adapter.prefixScheme).toBe("bge-v1.5:query-instruction;doc-raw;cls;l2;fp32");
  });

  it("returns nothing for an empty input without calling the model", async () => {
    const { fn } = fakeExtractor();
    const adapter = new TransformersEmbeddingAdapter(makeConfig(), fn as never);
    expect(await adapter.embed([], "query")).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});
