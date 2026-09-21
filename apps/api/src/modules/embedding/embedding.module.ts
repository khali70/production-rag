import { Module } from "@nestjs/common";
import { AppConfig } from "../../config/app-config.js";
import { TransformersEmbeddingAdapter } from "../../adapters/embedding/transformers-embedding.adapter.js";
import { EmbeddingPort } from "../../ports/embedding.port.js";

/**
 * EmbeddingPort is the DI token. Swapping providers is a change here and a
 * full re-embed, guarded by index_meta.
 */
@Module({
  providers: [
    {
      provide: EmbeddingPort,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => new TransformersEmbeddingAdapter(config),
    },
  ],
  exports: [EmbeddingPort],
})
export class EmbeddingModule {}
