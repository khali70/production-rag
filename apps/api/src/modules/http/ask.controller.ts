import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
} from "@nestjs/common";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { AccessScope, ScoredChunk } from "../../domain/types.js";
import { EmbeddingPort } from "../../ports/embedding.port.js";
import { LlmPort } from "../../ports/llm.port.js";
import { AnswerService } from "../answer/answer.service.js";
import { PackLoader } from "../corpus/pack.loader.js";
import { AskRequestSchema, toAskOptions } from "./ask.request.js";

/** public/ sits next to dist/ and src/, three levels up from this file. */
const PAGE = resolve(import.meta.dirname, "../../../public/ask.html");

/**
 * Chunk for the diagnostics panel. Includes the text: every chunk here already
 * passed the ACL filter for the selected user, and the server is localhost-only.
 */
const chunkView = (c: ScoredChunk) => ({
  chunkId: c.chunkId,
  documentId: c.source.documentId,
  version: c.source.version,
  title: c.source.title,
  section: c.source.sectionPath.join(" > "),
  cosine: c.cosine,
  rrf: c.score,
  tier: c.tier,
  level: c.level,
  status: c.status,
  trust: c.trust,
  text: c.text,
});

const round = (v: number) => Math.round(v * 1e5) / 1e5;

/**
 * Local playground for the answer pipeline: a page to ask questions as any
 * pack user, and the JSON endpoints behind it.
 *
 * There is no authentication. Picking a user is impersonation by design, so
 * main.ts binds to localhost only.
 */
@Controller()
export class AskController {
  constructor(
    @Inject(AnswerService) private readonly answers: AnswerService,
    @Inject(PackLoader) private readonly pack: PackLoader,
    @Inject(EmbeddingPort) private readonly embeddings: EmbeddingPort,
    @Inject(LlmPort) private readonly llm: LlmPort,
  ) {}

  @Get()
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  async page(): Promise<string> {
    return readFile(PAGE, "utf8");
  }

  @Get("api/users")
  async users() {
    const { users } = await this.pack.loadIdentities();
    return users.map((u) => ({
      userId: u.user_id,
      displayName: u.display_name ?? null,
      department: u.department,
      groups: u.groups,
    }));
  }

  @Get("api/info")
  info() {
    return {
      embedding: { modelId: this.embeddings.modelId, dim: this.embeddings.dim },
      llm: { modelId: this.llm.info.id },
    };
  }

  @Post("api/ask")
  @HttpCode(200)
  async ask(@Body() body: unknown) {
    let req;
    let options;
    try {
      req = AskRequestSchema.parse(body);
      options = toAskOptions(req);
    } catch (err) {
      if (err instanceof z.ZodError) throw new BadRequestException(z.prettifyError(err));
      throw err;
    }

    const { users } = await this.pack.loadIdentities();
    const user = users.find((u) => u.user_id === req.userId);
    if (!user) throw new NotFoundException(`Unknown user ${req.userId}`);
    const scope: AccessScope = { principalId: user.user_id, groups: user.groups, department: user.department };

    // Collect reasoning tokens per attempt, the same way the CLI trace does.
    const reasoning: string[] = [];
    let result;
    try {
      result = await this.answers.ask(scope, req.question, options, {
        onStage: (stage) => {
          if (stage === "generating") reasoning.push("");
        },
        onDelta: (kind, text) => {
          if (kind === "reasoning" && reasoning.length > 0) reasoning[reasoning.length - 1] += text;
        },
      });
    } catch (err) {
      throw new BadGatewayException(err instanceof Error ? err.message : String(err));
    }

    const d = result.debug;
    return {
      answer: result.answer,
      diagnostics: {
        user: { userId: user.user_id, groups: user.groups },
        embedding: {
          modelId: this.embeddings.modelId,
          prefixScheme: this.embeddings.prefixScheme,
          dim: d.embedding.dim,
          ms: d.embedding.ms,
          norm: round(Math.hypot(...d.embedding.vector)),
          vector: d.embedding.vector.map(round),
        },
        llm: {
          modelId: this.llm.info.id,
          prompt: d.prompt ?? null,
          raw: d.raw,
          reasoning,
        },
        searchMs: d.searchMs,
        bestCosine: d.bestCosine < -0.99 ? null : d.bestCosine,
        gate: d.gate ?? null,
        retrieved: d.retrieved.map(chunkView),
        offTopic: d.offTopic.map((c) => c.chunkId),
        rerank: d.rerank ? { modelId: d.rerank.modelId, ms: d.rerank.ms, scores: d.rerank.scores } : null,
        evidence: d.evidence.map((e) => ({
          id: e.id,
          role: e.role,
          documentId: e.documentId,
          version: e.version,
          title: e.title,
          note: e.note ?? null,
        })),
        generations: d.generations,
        totalMs: d.totalMs,
      },
    };
  }
}
