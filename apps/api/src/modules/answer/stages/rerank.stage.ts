import { Inject, Injectable } from "@nestjs/common";
import type { ScoredChunk } from "../../../domain/types.js";
import { RerankerPort } from "../../../ports/reranker.port.js";
import type { PipelineStage } from "./stage.js";

export type RerankInput = { question: string; chunks: ScoredChunk[]; topK: number };
export type Reranked = {
  /** The topK chunks by reranker score, best first. */
  chunks: ScoredChunk[];
  /** Score of every candidate, keyed by chunkId. */
  scores: Record<string, number>;
  modelId: string;
  ms: number;
};

/**
 * Candidate pool -> topK by cross-encoder score. Only reorders and trims what
 * search returned, so it can never widen what the caller may see.
 */
@Injectable()
export class RerankStage implements PipelineStage<RerankInput, Reranked> {
  constructor(@Inject(RerankerPort) private readonly reranker: RerankerPort) {}

  async run({ question, chunks, topK }: RerankInput): Promise<Reranked> {
    const started = Date.now();
    const raw = await this.reranker.score(question, chunks.map((c) => c.text));
    const scores = Object.fromEntries(chunks.map((c, i) => [c.chunkId, raw[i]!]));
    const ranked = [...chunks].sort((a, b) => scores[b.chunkId]! - scores[a.chunkId]!).slice(0, topK);
    return { chunks: ranked, scores, modelId: this.reranker.modelId, ms: Date.now() - started };
  }
}
