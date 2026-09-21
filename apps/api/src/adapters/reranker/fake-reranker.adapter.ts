import { RerankerPort } from "../../ports/reranker.port.js";

/**
 * Deterministic reranker for tests: the share of query words that appear in
 * the passage. No model download, byte-identical across runs.
 */
export class FakeReranker extends RerankerPort {
  readonly modelId = "fake-token-overlap-reranker";

  async score(query: string, passages: string[]): Promise<number[]> {
    const queryTokens = new Set(tokens(query));
    if (queryTokens.size === 0) return passages.map(() => 0);
    return passages.map((p) => {
      const passageTokens = new Set(tokens(p));
      let hits = 0;
      for (const t of queryTokens) if (passageTokens.has(t)) hits++;
      return hits / queryTokens.size;
    });
  }
}

const tokens = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
