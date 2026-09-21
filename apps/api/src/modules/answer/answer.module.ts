import { Module } from "@nestjs/common";
import { EmbeddingModule } from "../embedding/embedding.module.js";
import { GenerationModule } from "../generation/generation.module.js";
import { RerankerModule } from "../reranker/reranker.module.js";
import { VectorStoreModule } from "../vector-store/vector-store.module.js";
import { AnswerService } from "./answer.service.js";
import { EmbedStage } from "./stages/embed.stage.js";
import { GenerateStage } from "./stages/generate.stage.js";
import { RerankStage } from "./stages/rerank.stage.js";
import { SearchStage } from "./stages/search.stage.js";

@Module({
  imports: [EmbeddingModule, VectorStoreModule, RerankerModule, GenerationModule],
  providers: [EmbedStage, SearchStage, RerankStage, GenerateStage, AnswerService],
  exports: [AnswerService],
})
export class AnswerModule {}
