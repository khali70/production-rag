import type { AppConfig } from "../../config/app-config.js";
import { LlmPort, type GenerateRequest, type GenerateResult, type ModelInfo } from "../../ports/llm.port.js";

type ChatCompletion = {
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

type ChatCompletionChunk = {
  model?: string;
  choices?: { delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null } }[];
  usage?: ChatCompletion["usage"];
};

/**
 * POST {baseUrl}/v1/chat/completions. Covers Ollama, llama.cpp server,
 * LM Studio, vLLM and Azure OpenAI's OpenAI-compatible endpoint.
 */
export class OpenAiCompatLlm extends LlmPort {
  readonly info: ModelInfo;

  constructor(private readonly cfg: AppConfig["llm"]) {
    super();
    this.info = { id: cfg.modelId, provider: "openai-compat" };
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const messages = [
      { role: "system", content: req.system },
      ...req.messages.map((m, i) =>
        // Qwen3 convention: /no_think on the latest user turn turns off the thinking block.
        this.cfg.disableThinking && m.role === "user" && i === req.messages.length - 1
          ? { ...m, content: `${m.content}\n/no_think` }
          : m,
      ),
    ];

    const body: Record<string, unknown> = {
      model: this.cfg.modelId,
      messages,
      temperature: req.temperature ?? 0,
      max_tokens: req.maxTokens ?? this.cfg.maxTokens,
      // Streaming, so headers arrive at once. Node's fetch aborts after 300 s
      // without response headers, which a slow local model easily exceeds.
      stream: true,
      stream_options: { include_usage: true },
    };
    // /no_think alone is ignored by newer Qwen builds; Ollama honours reasoning_effort "none".
    if (this.cfg.disableThinking) body.reasoning_effort = "none";
    if (req.seed !== undefined) body.seed = req.seed;

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.apiKey.length > 0) headers.authorization = `Bearer ${this.cfg.apiKey}`;

    const timeout = AbortSignal.timeout(this.cfg.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;

    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`LLM request to ${this.cfg.baseUrl} failed: ${reason}`);
    }

    if (!res.ok) {
      // Status only: the body may echo the prompt, which can hold restricted text.
      throw new Error(`LLM returned HTTP ${res.status} for model ${this.cfg.modelId}`);
    }

    if (!res.body) throw new Error(`LLM returned an empty body for model ${this.cfg.modelId}`);

    // Server-sent events: `data: {chunk}` lines, ending with `data: [DONE]`.
    // Reasoning deltas are only reported through onDelta; only content is the answer.
    let raw = "";
    let model: string | undefined;
    let usage: ChatCompletion["usage"];
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const bytes of res.body) {
      buffer += decoder.decode(bytes, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        const chunk = JSON.parse(payload) as ChatCompletionChunk;
        const delta = chunk.choices?.[0]?.delta;
        const reasoning = delta?.reasoning ?? delta?.reasoning_content;
        if (reasoning) req.onDelta?.("reasoning", reasoning);
        if (delta?.content) {
          raw += delta.content;
          req.onDelta?.("content", delta.content);
        }
        model ??= chunk.model;
        if (chunk.usage) usage = chunk.usage;
      }
    }

    return {
      text: this.cfg.disableThinking ? stripThinking(raw) : raw,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
      },
      latencyMs: Date.now() - started,
      modelId: model ?? this.cfg.modelId,
    };
  }
}

/** Removes <think>...</think> blocks, including an empty one left by /no_think. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
