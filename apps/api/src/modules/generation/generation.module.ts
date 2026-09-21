import { Module } from "@nestjs/common";
import { AppConfig } from "../../config/app-config.js";
import { FakeLlm } from "../../adapters/llm/fake-llm.adapter.js";
import { OpenAiCompatLlm } from "../../adapters/llm/openai-compat.adapter.js";
import { LlmPort } from "../../ports/llm.port.js";

/** LlmPort is the DI token. Swapping model or provider is a config change. */
@Module({
  providers: [
    {
      provide: LlmPort,
      inject: [AppConfig],
      useFactory: (config: AppConfig): LlmPort => {
        switch (config.llm.provider) {
          case "openai-compat":
            return new OpenAiCompatLlm(config.llm);
          case "fake":
            return new FakeLlm();
        }
      },
    },
  ],
  exports: [LlmPort],
})
export class GenerationModule {}
