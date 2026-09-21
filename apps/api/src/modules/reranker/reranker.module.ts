import { Module } from "@nestjs/common";
import { AppConfig } from "../../config/app-config.js";
import { FakeReranker } from "../../adapters/reranker/fake-reranker.adapter.js";
import { TransformersRerankerAdapter } from "../../adapters/reranker/transformers-reranker.adapter.js";
import { RerankerPort } from "../../ports/reranker.port.js";

/** RerankerPort is the DI token. Swapping provider or model is a config change. The model loads lazily on first score(). */
@Module({
  providers: [
    {
      provide: RerankerPort,
      inject: [AppConfig],
      useFactory: (config: AppConfig): RerankerPort => {
        switch (config.reranker.provider) {
          case "transformers":
            return new TransformersRerankerAdapter(config);
          case "fake":
            return new FakeReranker();
        }
      },
    },
  ],
  exports: [RerankerPort],
})
export class RerankerModule {}
