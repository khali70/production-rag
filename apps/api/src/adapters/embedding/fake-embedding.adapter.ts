import { createHash } from "node:crypto";
import { EmbeddingPort } from "../../ports/embedding.port.js";

/**
 * Deterministic hash-based vectors. Used by the contract tests so they exercise
 * the store's filtering and ordering without a 133 MB model download.
 *
 * Token-overlap driven: two texts sharing words land closer together, which is
 * enough to assert that ACL filters and precedence ordering behave, while
 * staying byte-identical across runs.
 */
export class FakeEmbeddingAdapter extends EmbeddingPort {
  readonly modelId = "fake-hash-embedding";
  readonly prefixScheme = "fake:query-tag;doc-raw;none;l2;fp32";

  constructor(readonly dim = 384) {
    super();
  }

  async embed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    return texts.map((text) => this.vectorFor(kind === "query" ? text : text));
  }

  private vectorFor(text: string): number[] {
    const vec = new Array<number>(this.dim).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

    for (const token of tokens) {
      const digest = createHash("sha256").update(token).digest();
      // Two buckets per token keeps vectors from collapsing onto one axis.
      for (let k = 0; k < 2; k++) {
        const idx = digest.readUInt16BE(k * 2) % this.dim;
        const sign = digest[k * 2 + 4]! % 2 === 0 ? 1 : -1;
        vec[idx] += sign;
      }
    }

    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (norm === 0) {
      // Empty text still needs a unit vector: pgvector rejects a zero vector for cosine.
      vec[0] = 1;
      return vec;
    }
    return vec.map((v) => v / norm);
  }
}
