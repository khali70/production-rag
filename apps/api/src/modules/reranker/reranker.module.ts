import { Module } from "@nestjs/common";
import { AppConfig } from "../../config/app-config.js";
import { TransformersRerankerAdapter } from "../../adapters/reranker/transformers-reranker.adapter.js";
import { RerankerPort } from "../../ports/reranker.port.js";

/** RerankerPort is the DI token. The model loads lazily on first score(). */
@Module({
  providers: [
    {
      provide: RerankerPort,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => new TransformersRerankerAdapter(config),
    },
  ],
  exports: [RerankerPort],
})
export class RerankerModule {}
