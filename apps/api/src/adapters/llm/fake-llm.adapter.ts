import { REFUSAL } from "../../modules/answer/answer.finalizer.js";
import { LlmPort, type GenerateRequest, type GenerateResult, type ModelInfo } from "../../ports/llm.port.js";

/**
 * Deterministic LLM for tests. The responder sees the full request, so a test
 * can return a canned answer, an empty reply, or an invented number.
 * The default refuses, which is the safe behaviour.
 */
export class FakeLlm extends LlmPort {
  readonly info: ModelInfo = { id: "fake", provider: "fake" };
  readonly calls: GenerateRequest[] = [];

  constructor(
    private readonly responder: (req: GenerateRequest, call: number) => string = () =>
      `${REFUSAL} Fake LLM: no answer.`,
  ) {
    super();
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    return {
      text: this.responder(req, this.calls.length),
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: 0,
      modelId: this.info.id,
    };
  }
}
