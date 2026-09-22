import { Inject, Injectable } from "@nestjs/common";
import { LlmPort, type GenerateResult } from "../../../ports/llm.port.js";
import type { PipelineStage } from "./stage.js";

export type GenerateInput = {
  system: string;
  user: string;
  /** Fires before the model call. */
  onAttempt?: () => void;
  onDelta?: (kind: "content" | "reasoning", text: string) => void;
};

export type Generated = {
  /** The model's plain-text reply. */
  text: string;
  /** One entry per model call, kept as arrays so traces stay uniform. */
  raw: string[];
  generations: Omit<GenerateResult, "text">[];
};

/** Prompt -> plain-text reply. One call: there is no format to repair. */
@Injectable()
export class GenerateStage implements PipelineStage<GenerateInput, Generated> {
  constructor(@Inject(LlmPort) private readonly llm: LlmPort) {}

  get modelId(): string {
    return this.llm.info.id;
  }

  async run({ system, user, onAttempt, onDelta }: GenerateInput): Promise<Generated> {
    onAttempt?.();
    const { text, ...meta } = await this.llm.generate({
      system,
      messages: [{ role: "user", content: user }],
      temperature: 0,
      seed: 7,
      onDelta,
    });
    return { text, raw: [text], generations: [meta] };
  }
}
