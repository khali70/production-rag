import { Module } from "@nestjs/common";
import { EmbeddingModule } from "../embedding/embedding.module.js";
import { GenerationModule } from "../generation/generation.module.js";
import { VectorStoreModule } from "../vector-store/vector-store.module.js";
import { AnswerService } from "./answer.service.js";

@Module({
  imports: [EmbeddingModule, VectorStoreModule, GenerationModule],
  providers: [AnswerService],
  exports: [AnswerService],
})
export class AnswerModule {}
