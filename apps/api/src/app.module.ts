import { Module } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module.js";
import { CorpusModule } from "./modules/corpus/corpus.module.js";
import { EmbeddingModule } from "./modules/embedding/embedding.module.js";
import { VectorStoreModule } from "./modules/vector-store/vector-store.module.js";

@Module({
  imports: [AppConfigModule, EmbeddingModule, VectorStoreModule, CorpusModule],
})
export class AppModule {}
