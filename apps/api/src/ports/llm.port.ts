/**
 * Text generation provider. Abstract class so it doubles as the Nest DI token.
 * Source of the design: context/04-llm-and-embeddings.md.
 */
export type ModelInfo = {
  id: string;
  provider: "openai-compat" | "fake";
  supportsJsonSchema: boolean;
};

export type GenerateRequest = {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  /** JSON Schema the reply must match. The caller still validates the reply. */
  jsonSchema?: { name: string; schema: object };
  /** Defaults to 0: answers must be repeatable. */
  temperature?: number;
  seed?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called with each streamed piece of output, for live progress. Reasoning is never part of the answer. */
  onDelta?: (kind: "content" | "reasoning", text: string) => void;
};

export type GenerateResult = {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
  modelId: string;
};

export abstract class LlmPort {
  abstract readonly info: ModelInfo;
  abstract generate(req: GenerateRequest): Promise<GenerateResult>;
}
