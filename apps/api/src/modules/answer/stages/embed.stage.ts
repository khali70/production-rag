import { Inject, Injectable } from "@nestjs/common";
import { EmbeddingPort } from "../../../ports/embedding.port.js";
import type { PipelineStage } from "./stage.js";

export type Embedded = { vector: number[]; ms: number };

/** question -> query vector. The adapter owns the query prefix. */
@Injectable()
export class EmbedStage implements PipelineStage<string, Embedded> {
  constructor(@Inject(EmbeddingPort) private readonly embeddings: EmbeddingPort) {}

  async run(question: string): Promise<Embedded> {
    const started = Date.now();
    const [vector] = await this.embeddings.embed([question], "query");
    return { vector: vector!, ms: Date.now() - started };
  }
}
