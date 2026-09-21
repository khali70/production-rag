/**
 * Cross-encoder reranker. Abstract class so it doubles as the Nest DI token.
 *
 * Scores a query against each candidate passage jointly, which is slower but
 * sharper than comparing precomputed embeddings. Only ever applied to the
 * small candidate set that search already returned, so it never widens what
 * a caller can see: permissions and lifecycle filters stay in the store.
 */
export abstract class RerankerPort {
  abstract readonly modelId: string;

  /** Relevance of each passage to the query in [0, 1], in the order given. */
  abstract score(query: string, passages: string[]): Promise<number[]>;
}
