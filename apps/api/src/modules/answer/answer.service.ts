import { Inject, Injectable } from "@nestjs/common";
import type { AccessScope, ScoredChunk, SearchQuery } from "../../domain/types.js";
import { EmbeddingPort } from "../../ports/embedding.port.js";
import { LlmPort, type GenerateResult } from "../../ports/llm.port.js";
import { VectorStorePort } from "../../ports/vector-store.port.js";
import { MODEL_ANSWER_JSON_SCHEMA, ModelAnswerSchema, type Answer, type ModelAnswer } from "./answer.schema.js";
import { validateAnswer } from "./answer.validator.js";
import { resolveEvidence, type EvidenceDoc } from "./evidence.resolver.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.builder.js";

export type AskOptions = Omit<SearchQuery, "text" | "embedding"> & {
  /**
   * Evidence gate: refuse without calling the model when the best cosine is
   * below this. Deterministic, so a weak retrieval never becomes a fluent answer.
   */
  gateCosine: number;
  /**
   * Chunks whose cosine is more than this below the best one are dropped as
   * off-topic before authority is resolved. Without it an unrelated policy at
   * the same level becomes a second "equal authority" primary.
   */
  relativeCosineMargin: number;
  maxContextChars: number;
};

export type AskResult = {
  answer: Answer;
  /** For the CLI and evals. Holds document text: never log or return it to an unprivileged caller. */
  debug: {
    embedding: { dim: number; preview: number[]; ms: number };
    retrieved: ScoredChunk[];
    searchMs: number;
    bestCosine: number;
    gate?: string;
    /** Chunks removed by the relative cosine margin. */
    offTopic: ScoredChunk[];
    evidence: EvidenceDoc[];
    prompt?: { system: string; user: string };
    raw: string[];
    generations: Omit<GenerateResult, "text">[];
    /** One entry per model attempt: null when the reply parsed. */
    parseErrors: (string | null)[];
    totalMs: number;
  };
};

export type AskHooks = {
  /** Fires as each stage completes, so a caller can print a live trace. */
  onStage?: (stage: "embedded" | "retrieved" | "resolved" | "prompted" | "generating", debug: AskResult["debug"]) => void;
  onDelta?: (kind: "content" | "reasoning", text: string) => void;
};

const refusal = (summary: string, warning: string): Answer => ({
  status: "refused",
  summary,
  claims: [],
  conflicts: [],
  missing: [],
  warnings: [warning],
});

@Injectable()
export class AnswerService {
  constructor(
    @Inject(EmbeddingPort) private readonly embeddings: EmbeddingPort,
    @Inject(VectorStorePort) private readonly store: VectorStorePort,
    @Inject(LlmPort) private readonly llm: LlmPort,
  ) {}

  async ask(scope: AccessScope, question: string, opts: AskOptions, hooks: AskHooks = {}): Promise<AskResult> {
    const { gateCosine, relativeCosineMargin, maxContextChars, ...searchOpts } = opts;
    const asOf = searchOpts.asOf ?? new Date().toISOString().slice(0, 10);
    const started = Date.now();

    let t = Date.now();
    const [embedding] = await this.embeddings.embed([question], "query");
    const debug: AskResult["debug"] = {
      embedding: { dim: embedding!.length, preview: embedding!.slice(0, 8), ms: Date.now() - t },
      retrieved: [],
      searchMs: 0,
      bestCosine: -1,
      offTopic: [],
      evidence: [],
      raw: [],
      generations: [],
      parseErrors: [],
      totalMs: 0,
    };
    hooks.onStage?.("embedded", debug);
    const done = (answer: Answer): AskResult => {
      debug.totalMs = Date.now() - started;
      return { answer, debug };
    };

    t = Date.now();
    const retrieved = await this.store.search(scope, { ...searchOpts, asOf, text: question, embedding: embedding! });
    debug.retrieved = retrieved;
    debug.searchMs = Date.now() - t;

    // 1. Evidence gate, before any model call.
    const best = Math.max(-1, ...retrieved.map((c) => c.cosine ?? -1));
    debug.bestCosine = best;
    if (retrieved.length === 0 || best < gateCosine) {
      debug.gate = retrieved.length === 0 ? "no visible chunks" : `best cosine ${best.toFixed(3)} < ${gateCosine}`;
    }
    hooks.onStage?.("retrieved", debug);
    if (debug.gate) {
      return done(refusal("I could not find trustworthy information you have access to that answers this.", `gate: ${debug.gate}`));
    }

    // 2. Drop off-topic chunks, then versioning + authority, in code.
    //    Full-text-only hits (cosine null) are kept; the SQL minCosine already governs them.
    const isOnTopic = (c: ScoredChunk) => c.cosine === null || c.cosine >= best - relativeCosineMargin;
    debug.offTopic = retrieved.filter((c) => !isOnTopic(c));
    const evidence = resolveEvidence(retrieved.filter(isOnTopic));
    debug.evidence = evidence;
    hooks.onStage?.("resolved", debug);

    // 3. Generate, parse, one repair retry, then refuse. Never fall back to free text.
    const user = buildUserPrompt(evidence, { question, asOf, maxContextChars });
    debug.prompt = { system: SYSTEM_PROMPT, user };
    hooks.onStage?.("prompted", debug);
    const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: user }];

    let parsed: ModelAnswer | undefined;
    let lastError = "";
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      hooks.onStage?.("generating", debug);
      const { text, ...meta } = await this.llm.generate({
        system: SYSTEM_PROMPT,
        messages,
        jsonSchema: MODEL_ANSWER_JSON_SCHEMA,
        temperature: 0,
        seed: 7,
        onDelta: hooks.onDelta,
      });
      debug.raw.push(text);
      debug.generations.push(meta);

      const result = parseModelAnswer(text);
      debug.parseErrors.push(result.ok ? null : result.error);
      if (result.ok) parsed = result.value;
      else {
        lastError = result.error;
        messages.push(
          { role: "assistant", content: text },
          { role: "user", content: `That reply was invalid: ${result.error}. Reply again with JSON matching the schema only.` },
        );
      }
    }

    if (!parsed) {
      return done(refusal("I could not produce a reliable answer for this question.", `model output invalid twice: ${lastError}`));
    }

    // 4. Validate against the evidence the model was actually given.
    return done(validateAnswer(parsed, evidence));
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
