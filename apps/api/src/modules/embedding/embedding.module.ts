import { Module } from "@nestjs/common";
import { AppConfig } from "../../config/app-config.js";
import { FakeEmbeddingAdapter } from "../../adapters/embedding/fake-embedding.adapter.js";
import { TransformersEmbeddingAdapter } from "../../adapters/embedding/transformers-embedding.adapter.js";
import { EmbeddingPort } from "../../ports/embedding.port.js";

/**
 * EmbeddingPort is the DI token. Swapping provider or model is a config
 * change plus a full re-embed, guarded by index_meta.
 */
@Module({
  providers: [
    {
      provide: EmbeddingPort,
      inject: [AppConfig],
      useFactory: (config: AppConfig): EmbeddingPort => {
        switch (config.embedding.provider) {
          case "transformers":
            return new TransformersEmbeddingAdapter(config);
          case "fake":
            return new FakeEmbeddingAdapter(config.embedding.dim);
        }
      },
    },
  ],
  exports: [EmbeddingPort],
})
export class EmbeddingModule {}
