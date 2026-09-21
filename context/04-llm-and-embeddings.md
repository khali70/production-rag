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
  abstract readonly prefixScheme: string;
  abstract embed(texts: string[], kind: "query" | "document"): Promise<number[][]>;
}
```
- `kind` exists because bge/e5 style models use different query vs document prefixes.
- Changing embedding model, dim, dtype or prefix scheme requires a full re-embed. `index_meta` stores all four; `search` throws `IndexMismatchError` rather than returning quietly wrong results, and `ingest --reindex` is the only way to rewrite it.
- Adapters: transformers.js (in-process CPU), OpenAI-compatible (Ollama, Azure OpenAI).

### Implemented adapter (local default)
`TransformersEmbeddingAdapter`: `@huggingface/transformers` `pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', { dtype: 'fp32', device: 'cpu' })`, lazy singleton, batches of 16, asserts the returned dim equals `EMBEDDING_DIM`.

- **CLS pooling, not mean.** bge-small's `1_Pooling/config.json` sets `pooling_mode_cls_token: true`; mean pooling silently degrades it.
- L2 normalize, so cosine is a dot product and pgvector's `vector_cosine_ops` behaves.
- Query prefix `"Represent this sentence for searching relevant passages: "` on `kind: "query"` only, never on documents. Applying it to documents is a common and quiet quality loss.
- `prefixScheme` = `bge-v1.5:query-instruction;doc-raw;cls;l2;fp32`, recorded in `index_meta`.
- First run downloads ~133 MB of ONNX into `EMBEDDING_CACHE_DIR`. CPU only, no network at query time.
- `FakeEmbeddingAdapter` (deterministic SHA-256 token-hash vectors) backs the contract tests, so they need no model download.

Ollama was considered and dropped for embeddings: `embeddinggemma` listed by `ollama list` but `POST /api/embed` answered `model not found`, and an in-process adapter removes a runtime prerequisite from the assessed path anyway. Ollama stays the likely LLM provider through the OpenAI-compatible adapter.

## Model candidates (verify catalogs at build time, names may be dated)

Local CPU prototype:
- LLM (Q4 via Ollama): Qwen3 4B, Phi-4-mini, Llama 3.2 3B, Gemma 3 4B. Benchmark 2-3.
- Embeddings: bge-small-en-v1.5 (384d, fast), nomic-embed-text (768d, Matryoshka), bge-m3 (1024d, Arabic + English, dense + sparse).

Azure production:
- LLM: Azure OpenAI GPT-4o-mini or current mini tier for answers, larger model for hard cases.
- Embeddings: text-embedding-3-small, or 3-large truncated to 256-1024 dims.

Current pick: bge-small-en-v1.5 in-process (built, corpus is English only). LLM still open; Qwen3 4B via Ollama is the leading candidate.
