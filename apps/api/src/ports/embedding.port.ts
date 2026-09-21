/**
 * Embedding provider. Abstract class so it doubles as the Nest DI token.
 *
 * `kind` exists because bge/e5 style models use a different instruction for
 * queries than for documents. Getting it wrong costs recall silently, with no
 * error, so the prefix belongs to the adapter and never to the caller.
 */
export abstract class EmbeddingPort {
  abstract readonly modelId: string;
  abstract readonly dim: number;

  /**
   * Identifies everything that changes the vector space beyond the model name:
   * prefix convention, pooling, normalization and dtype.
   * Stored in index_meta; a mismatch blocks search instead of returning noise.
   */
  abstract readonly prefixScheme: string;

  abstract embed(texts: string[], kind: "query" | "document"): Promise<number[][]>;
}
