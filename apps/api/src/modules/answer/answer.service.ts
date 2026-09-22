import { Inject, Injectable } from "@nestjs/common";
import type { AccessScope, ScoredChunk, SearchQuery } from "../../domain/types.js";
import type { GenerateResult } from "../../ports/llm.port.js";
import type { Answer } from "./answer.types.js";
import { finalizeAnswer } from "./answer.finalizer.js";
import { resolveEvidence, type EvidenceDoc } from "./evidence.resolver.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.builder.js";
import { EmbedStage } from "./stages/embed.stage.js";
import { GenerateStage } from "./stages/generate.stage.js";
import { RerankStage } from "./stages/rerank.stage.js";
import { SearchStage } from "./stages/search.stage.js";

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
   * Ignored when reranking: the reranker score is the sharper signal.
   */
  relativeCosineMargin: number;
  maxContextChars: number;
  /**
   * For every document the search found, also fetch this many chunks from each
   * of its other versions the user can see, so the model gets old and current
   * text of the same file side by side. 0 turns it off.
   */
  versionChunks: number;
  /**
   * When set, search fetches `pool` chunks by relevance, the reranker keeps
   * the best `topK`, and chunks scoring below `minScore` are dropped as
   * off-topic. Precedence is still applied afterwards by the evidence resolver.
   */
  rerank?: { pool: number; minScore: number };
};

export type AskResult = {
  answer: Answer;
  /** For the CLI and evals. Holds document text: never log or return it to an unprivileged caller. */
  debug: {
    /** vector is the full query embedding, for diagnostics UIs. */
    embedding: { dim: number; preview: number[]; vector: number[]; ms: number };
    retrieved: ScoredChunk[];
    searchMs: number;
    bestCosine: number;
    gate?: string;
    rerank?: { modelId: string; ms: number; scores: Record<string, number>; kept: ScoredChunk[] };
    /** Chunks removed by the relative cosine margin, or by the rerank floor when reranking. */
    offTopic: ScoredChunk[];
    /** Chunks of other versions of the found documents, added after the off-topic filter. */
    versions: { chunks: ScoredChunk[]; ms: number };
    evidence: EvidenceDoc[];
    prompt?: { system: string; user: string };
    raw: string[];
    generations: Omit<GenerateResult, "text">[];
    totalMs: number;
  };
};

export type AskStage = "embedded" | "retrieved" | "reranked" | "versions" | "resolved" | "prompted" | "generating";

export type AskHooks = {
  /** Fires as each stage completes, so a caller can print a live trace. */
  onStage?: (stage: AskStage, debug: AskResult["debug"]) => void;
  onDelta?: (kind: "content" | "reasoning", text: string) => void;
};

const refusal = (text: string, warning: string): Answer => ({
  status: "refused",
  text,
  message: text,
  sources: [],
  warnings: [warning],
});

const NOT_FOUND = "I could not find trustworthy information you have access to that answers this.";

/**
 * Orchestrates the answer pipeline. Each model-backed step is a stage behind
 * its own port, so swapping the embedder, reranker or LLM is a config change:
 *
 *   embed -> search -> gate -> [rerank] -> off-topic filter -> other versions -> resolve authority
 *         -> prompt -> generate -> finalize (sources + number check)
 *
 * The gate, filter, resolver and finalizer are plain code: no model decides
 * what evidence is trusted, and the sources list is never written by the model.
 */
@Injectable()
export class AnswerService {
  constructor(
    @Inject(EmbedStage) private readonly embed: EmbedStage,
    @Inject(SearchStage) private readonly search: SearchStage,
    @Inject(RerankStage) private readonly rerank: RerankStage,
    @Inject(GenerateStage) private readonly generate: GenerateStage,
  ) {}

  async ask(scope: AccessScope, question: string, opts: AskOptions, hooks: AskHooks = {}): Promise<AskResult> {
    const { gateCosine, relativeCosineMargin, maxContextChars, versionChunks, rerank, ...searchOpts } = opts;
    if (rerank && rerank.pool < searchOpts.topK) {
      throw new Error(`rerank.pool (${rerank.pool}) must be >= topK (${searchOpts.topK})`);
    }
    const asOf = searchOpts.asOf ?? new Date().toISOString().slice(0, 10);
    const started = Date.now();

    // 1. Embed the question.
    const embedded = await this.embed.run(question);
    const debug: AskResult["debug"] = {
      embedding: {
        dim: embedded.vector.length,
        preview: embedded.vector.slice(0, 8),
        vector: embedded.vector,
        ms: embedded.ms,
      },
      retrieved: [],
      searchMs: 0,
      bestCosine: -1,
      offTopic: [],
      versions: { chunks: [], ms: 0 },
      evidence: [],
      raw: [],
      generations: [],
      totalMs: 0,
    };
    hooks.onStage?.("embedded", debug);
    const done = (answer: Answer): AskResult => {
      debug.totalMs = Date.now() - started;
      return { answer, debug };
    };

    // 2. Search. When reranking, fetch a wider pool by relevance: precedence
    //    would otherwise push relevant lower-tier chunks out before the reranker sees them.
    const searched = await this.search.run({
      scope,
      query: {
        ...searchOpts,
        asOf,
        text: question,
        embedding: embedded.vector,
        topK: rerank ? rerank.pool : searchOpts.topK,
        orderBy: rerank ? "relevance" : searchOpts.orderBy,
      },
    });
    debug.retrieved = searched.chunks;
    debug.searchMs = searched.ms;

    // 3. Evidence gate, before any model call (reranker included).
    const best = Math.max(-1, ...searched.chunks.map((c) => c.cosine ?? -1));
    debug.bestCosine = best;
    if (searched.chunks.length === 0 || best < gateCosine) {
      debug.gate = searched.chunks.length === 0 ? "no visible chunks" : `best cosine ${best.toFixed(3)} < ${gateCosine}`;
    }
    hooks.onStage?.("retrieved", debug);
    if (debug.gate) return done(refusal(NOT_FOUND, `gate: ${debug.gate}`));

    // 4. Rerank, then drop off-topic chunks.
    let onTopic: ScoredChunk[];
    if (rerank) {
      const reranked = await this.rerank.run({ question, chunks: searched.chunks, topK: searchOpts.topK });
      debug.rerank = { modelId: reranked.modelId, ms: reranked.ms, scores: reranked.scores, kept: reranked.chunks };
      hooks.onStage?.("reranked", debug);
      onTopic = reranked.chunks.filter((c) => reranked.scores[c.chunkId]! >= rerank.minScore);
      debug.offTopic = reranked.chunks.filter((c) => !onTopic.includes(c));
      if (onTopic.length === 0) {
        debug.gate = `every reranked chunk scored below ${rerank.minScore}`;
        return done(refusal(NOT_FOUND, `gate: ${debug.gate}`));
      }
    } else {
      // Full-text-only hits (cosine null) are kept; the SQL minCosine already governs them.
      const isOnTopic = (c: ScoredChunk) => c.cosine === null || c.cosine >= best - relativeCosineMargin;
      onTopic = searched.chunks.filter(isOnTopic);
      debug.offTopic = searched.chunks.filter((c) => !isOnTopic(c));
    }

    // 5. Other versions of every document found, so old and current text of
    //    the same file reach the model together. Not off-topic filtered: an
    //    old version is context for the current one, whatever its cosine.
    if (versionChunks > 0) {
      debug.versions = await this.search.versions(scope, {
        embedding: embedded.vector,
        documentIds: [...new Set(onTopic.map((c) => c.source.documentId))],
        skipVersions: [...new Set(onTopic.map((c) => `${c.source.documentId}@${c.source.version}`))],
        perVersion: versionChunks,
        includeStatuses: searchOpts.includeStatuses,
        asOf,
      });
    }
    hooks.onStage?.("versions", debug);

    // 6. Versioning + authority, in code.
    const evidence = resolveEvidence([...onTopic, ...debug.versions.chunks]);
    debug.evidence = evidence;
    hooks.onStage?.("resolved", debug);

    // 7. Prompt and generate.
    const user = buildUserPrompt(evidence, { question, asOf, maxContextChars });
    debug.prompt = { system: SYSTEM_PROMPT, user };
    hooks.onStage?.("prompted", debug);
    const generated = await this.generate.run({
      system: SYSTEM_PROMPT,
      user,
      onAttempt: () => hooks.onStage?.("generating", debug),
      onDelta: hooks.onDelta,
    });
    debug.raw = generated.raw;
    debug.generations = generated.generations;

    // 8. Append the sources and check numbers against the evidence the model was given.
    return done(finalizeAnswer(generated.text, evidence, { question, asOf }));
  }
}
