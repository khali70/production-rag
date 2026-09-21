import { Module } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module.js";
import { AnswerModule } from "./modules/answer/answer.module.js";
import { CorpusModule } from "./modules/corpus/corpus.module.js";
import { EmbeddingModule } from "./modules/embedding/embedding.module.js";
import { RerankerModule } from "./modules/reranker/reranker.module.js";
import { VectorStoreModule } from "./modules/vector-store/vector-store.module.js";

@Module({
  imports: [AppConfigModule, EmbeddingModule, RerankerModule, VectorStoreModule, CorpusModule, AnswerModule],
})
export class AppModule {}
