# LLM and embeddings (swappable)

## LLM port
One abstract class used as the Nest DI token. Provider chosen by env / `models.yaml`.

```ts
export abstract class LlmPort {
  abstract readonly info: ModelInfo;
  abstract generate(req: GenerateRequest): Promise<GenerateResult>;
}

export type ModelInfo = {
  id: string;                 // "qwen3:4b-q4_K_M"
  provider: "openai-compat" | "anthropic" | "fake";
  contextWindow: number;
  supportsJsonSchema: boolean;
};

export type GenerateRequest = {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  jsonSchema?: object;
  temperature?: number;       // default 0
  seed?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export type GenerateResult = {
  text: string;
  json?: unknown;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
  modelId: string;
};
```

```ts
{
  provide: LlmPort,
  inject: [AppConfig],
  useFactory: (cfg: AppConfig) => {
    switch (cfg.llm.provider) {
      case "openai-compat": return new OpenAiCompatLlm(cfg.llm);
      case "fake":          return new FakeLlm();
    }
  },
}
```

Notes:
- The OpenAI-compatible adapter covers Ollama, llama.cpp server, LM Studio, vLLM and Azure OpenAI.
- `models.yaml` holds per-model quirks (context window, JSON schema support, prompt tweaks). Swapping model = config change.
- No JSON schema support: JSON in text + zod parse + one retry, then refuse. Never fall back to free text.
- Pick the model by eval matrix, not feel.

## Embedding port
```ts
export abstract class EmbeddingPort {
  abstract readonly modelId: string;
  abstract readonly dim: number;
  abstract embed(texts: string[], kind: "query" | "document"): Promise<number[][]>;
}
```
- `kind` exists because bge/e5 style models use different query vs document prefixes.
- Changing embedding model requires full re-embed. Store model id + dim in index metadata; refuse to query on mismatch.
- Adapters: transformers.js (in-process CPU), OpenAI-compatible (Ollama, Azure OpenAI).

## Model candidates (verify catalogs at build time, names may be dated)

Local CPU prototype:
- LLM (Q4 via Ollama): Qwen3 4B, Phi-4-mini, Llama 3.2 3B, Gemma 3 4B. Benchmark 2-3.
- Embeddings: bge-small-en-v1.5 (384d, fast), nomic-embed-text (768d, Matryoshka), bge-m3 (1024d, Arabic + English, dense + sparse).

Azure production:
- LLM: Azure OpenAI GPT-4o-mini or current mini tier for answers, larger model for hard cases.
- Embeddings: text-embedding-3-small, or 3-large truncated to 256-1024 dims.

Current pick: Qwen3 4B + bge-m3 if Arabic content matters, otherwise bge-small for speed.
