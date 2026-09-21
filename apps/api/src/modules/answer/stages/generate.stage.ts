import { Inject, Injectable } from "@nestjs/common";
import { LlmPort, type GenerateResult } from "../../../ports/llm.port.js";
import { MODEL_ANSWER_JSON_SCHEMA, ModelAnswerSchema, type ModelAnswer } from "../answer.schema.js";
import type { PipelineStage } from "./stage.js";

export type GenerateInput = {
  system: string;
  user: string;
  /** Fires before each model attempt. */
  onAttempt?: () => void;
  onDelta?: (kind: "content" | "reasoning", text: string) => void;
};

export type Generated = {
  /** Undefined when both attempts failed to parse. */
  answer?: ModelAnswer;
  raw: string[];
  generations: Omit<GenerateResult, "text">[];
  /** One entry per attempt: null when the reply parsed. */
  parseErrors: (string | null)[];
};

const MAX_ATTEMPTS = 2;

/** Prompt -> schema-valid model answer: generate, parse, one repair retry. Never falls back to free text. */
@Injectable()
export class GenerateStage implements PipelineStage<GenerateInput, Generated> {
  constructor(@Inject(LlmPort) private readonly llm: LlmPort) {}

  get modelId(): string {
    return this.llm.info.id;
  }

  async run({ system, user, onAttempt, onDelta }: GenerateInput): Promise<Generated> {
    const out: Generated = { raw: [], generations: [], parseErrors: [] };
    const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: user }];

    for (let attempt = 0; attempt < MAX_ATTEMPTS && !out.answer; attempt++) {
      onAttempt?.();
      const { text, ...meta } = await this.llm.generate({
        system,
        messages,
        jsonSchema: MODEL_ANSWER_JSON_SCHEMA,
        temperature: 0,
        seed: 7,
        onDelta,
      });
      out.raw.push(text);
      out.generations.push(meta);

      const result = parseModelAnswer(text);
      out.parseErrors.push(result.ok ? null : result.error);
      if (result.ok) out.answer = result.value;
      else {
        messages.push(
          { role: "assistant", content: text },
          { role: "user", content: `That reply was invalid: ${result.error}. Reply again with JSON matching the schema only.` },
        );
      }
    }
    return out;
  }
}

export function parseModelAnswer(text: string): { ok: true; value: ModelAnswer } | { ok: false; error: string } {
  // Some models wrap JSON in a code fence even in JSON mode.
  const body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  const result = ModelAnswerSchema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    error: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
  };
}
