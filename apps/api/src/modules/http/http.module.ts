import { Module } from "@nestjs/common";
import { AnswerModule } from "../answer/answer.module.js";
import { CorpusModule } from "../corpus/corpus.module.js";
import { EmbeddingModule } from "../embedding/embedding.module.js";
import { GenerationModule } from "../generation/generation.module.js";
import { AskController } from "./ask.controller.js";

@Module({
  imports: [AnswerModule, CorpusModule, EmbeddingModule, GenerationModule],
  controllers: [AskController],
})
export class HttpModule {}
