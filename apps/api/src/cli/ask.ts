import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AppModule } from "../app.module.js";
import { AppConfig, REPO_ROOT } from "../config/app-config.js";
import type { AccessScope, Status } from "../domain/types.js";
import { PackLoader } from "../modules/corpus/pack.loader.js";
import { AnswerService, type AskOptions } from "../modules/answer/answer.service.js";
import { EmbeddingPort } from "../ports/embedding.port.js";
import { LlmPort } from "../ports/llm.port.js";
import { formatAnswer, formatTrace } from "../modules/answer/ask.trace.js";
import { RERANK_MIN_SCORE, RERANK_POOL } from "../modules/http/ask.request.js";

/**
 * Ask a question end to end as a given user: embed, retrieve, gate, resolve
 * authority, prompt, generate, finalize. Prints live progress and the answer,
 * and writes a full human-readable trace (every step, including the prompt)
 * to traces/ at the repo root.
 *
 *   node dist/cli/ask.js --user u-proc-310 "What is our process for approving a new enterprise vendor?"
 *   node dist/cli/ask.js --user u-proc-310 --trace-file traces/vendor.txt "vendor approval process"
 *   node dist/cli/ask.js --user u-proc-310 --rerank-pool 20 "who approves a 40k vendor"
 *   node dist/cli/ask.js --user u-proc-310 --mode llm --k 8 --no-rerank "who approves a 40k vendor"
 *
 * Default mode is retrieval: the reranker's best chunk is the answer, no LLM.
 *
 * The trace holds document text: it is for local debugging and is gitignored.
 */
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      user: { type: "string" },
      mode: { type: "string", default: "retrieval" },
      k: { type: "string", default: "3" },
      order: { type: "string", default: "precedence" },
      statuses: { type: "string", default: "current,superseded,retired" },
      "version-chunks": { type: "string", default: "2" },
      "related-chunks": { type: "string", default: "1" },
      "min-cosine": { type: "string" },
      "gate-cosine": { type: "string", default: "0.4" },
      "cosine-margin": { type: "string", default: "0.25" },
      "as-of": { type: "string" },
      "max-context-chars": { type: "string", default: "12000" },
      "no-rerank": { type: "boolean", default: false },
      "rerank-pool": { type: "string", default: String(RERANK_POOL) },
      "rerank-min": { type: "string", default: String(RERANK_MIN_SCORE) },
      "trace-file": { type: "string", default: "traces/ask.txt" },
      quiet: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });

  const question = positionals.join(" ").trim();
  if (!values.user || question.length === 0) {
    throw new Error(
      `Usage: ask --user <user_id> [--mode retrieval|llm] [--k 3] [--order relevance|precedence] [--statuses current,superseded,retired] [--version-chunks 2] [--related-chunks 1] [--min-cosine N] [--gate-cosine 0.4] [--cosine-margin 0.25] [--as-of YYYY-MM-DD] [--max-context-chars 12000] [--no-rerank] [--rerank-pool ${RERANK_POOL}] [--rerank-min ${RERANK_MIN_SCORE}] [--trace-file path.txt] [--quiet] [--json] "question"`,
    );
  }

  const num = (name: string, value: string | undefined, check: (n: number) => boolean): number => {
    const n = Number(value);
    if (!check(n)) throw new Error(`--${name} is invalid: "${value}"`);
    return n;
  };
  if (values.mode !== "retrieval" && values.mode !== "llm") throw new Error(`--mode is invalid: "${values.mode}"`);
  const options: AskOptions = {
    mode: values.mode,
    topK: num("k", values.k, (n) => Number.isInteger(n) && n > 0),
    includeStatuses: values.statuses!.split(",") as Status[],
    minCosine:
      values["min-cosine"] === undefined ? undefined : num("min-cosine", values["min-cosine"], (n) => n >= -1 && n <= 1),
    asOf: values["as-of"],
    orderBy: values.order === "relevance" ? "relevance" : "precedence",
    gateCosine: num("gate-cosine", values["gate-cosine"], (n) => n >= -1 && n <= 1),
    relativeCosineMargin: num("cosine-margin", values["cosine-margin"], (n) => n >= 0 && n <= 2),
    maxContextChars: num("max-context-chars", values["max-context-chars"], (n) => Number.isInteger(n) && n > 0),
    versionChunks: num("version-chunks", values["version-chunks"], (n) => Number.isInteger(n) && n >= 0),
    relatedChunks: num("related-chunks", values["related-chunks"], (n) => Number.isInteger(n) && n >= 0),
    rerank: !values["no-rerank"]
      ? {
        pool: num("rerank-pool", values["rerank-pool"], (n) => Number.isInteger(n) && n > 0),
        minScore: num("rerank-min", values["rerank-min"], (n) => n >= 0 && n <= 1),
      }
      : undefined,
  };

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  // Every run gets its own trace file. A provided --trace-file is a template:
  // the run stamp is injected before its extension so runs never overwrite.
  const stampName = (p: string): string => {
    const dot = p.lastIndexOf(".");
    const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return dot > slash ? `${p.slice(0, dot)}-${stamp}${p.slice(dot)}` : `${p}-${stamp}`;
  };
  const tracePath = resolve(
    REPO_ROOT,
    values["trace-file"] ? stampName(values["trace-file"]) : `traces/ask-${stamp}-${values.user}.txt`,
  );

  // Live progress goes to stderr so --json stdout stays clean.
  const live = values.quiet || values.json ? () => {} : (s: string) => process.stderr.write(s);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["warn", "error"] });

  try {
    const identities = await app.get(PackLoader).loadIdentities();
    const user = identities.users.find((u) => u.user_id === values.user);
    if (!user) throw new Error(`Unknown user ${values.user}. Identity lookup is server-side.`);
    const scope: AccessScope = { principalId: user.user_id, groups: user.groups, department: user.department };

    const config = app.get(AppConfig);
    const embeddings = app.get(EmbeddingPort);
    const llmId = app.get(LlmPort).info.id;
    const reasoning: string[] = [];
    let attempt = -1;
    let phase: "reasoning" | "content" | null = null;
    let tick = Date.now();
    const elapsed = () => {
      const ms = Date.now() - tick;
      tick = Date.now();
      return `${ms} ms`;
    };

    live(`\n${user.user_id} (${user.groups.join(", ")}) asks: ${question}\n\n`);
    live("[1] embedding the question... ");

    const result = await app.get(AnswerService).ask(scope, question, options, {
      onStage: (stage, d) => {
        switch (stage) {
          case "embedded":
            live(`done (${d.embedding.dim} dims, ${d.embedding.ms} ms)\n[2] searching the vector db... `);
            elapsed();
            break;
          case "retrieved":
            live(`${d.retrieved.length} chunks (${d.searchMs} ms)\n`);
            live(
              d.gate
                ? `[3] evidence gate: REFUSE (${d.gate})\n`
                : `[3] evidence gate: pass (best cosine ${d.bestCosine.toFixed(3)} >= ${options.gateCosine})\n`,
            );
            if (!d.gate && options.rerank) live(`[3b] reranking ${d.retrieved.length} chunks... `);
            break;
          case "reranked":
            live(`kept ${d.rerank!.kept.length} (${d.rerank!.modelId}, ${d.rerank!.ms} ms)\n`);
            for (const [i, c] of d.rerank!.kept.entries()) {
              live(`      ${i + 1}. rerank=${d.rerank!.scores[c.chunkId]!.toFixed(4)} ${c.source.documentId} v${c.source.version} [${c.source.sectionPath.join(" > ")}]\n`);
            }
            break;
          case "matched":
            live(`[4] off-topic filter${options.rerank ? ` (rerank < ${options.rerank.minScore})` : ""}: dropped ${d.offTopic.length} chunk(s)\n`);
            live(`[5] best match: ${d.best!.source.documentId} v${d.best!.source.version} [${d.best!.source.sectionPath.join(" > ")}]\n`);
            for (const c of d.related.chunks) live(`[5b] + amended by ${c.source.documentId} v${c.source.version}\n`);
            break;
          case "related":
            if (options.relatedChunks > 0) live(`[4b] related documents: ${d.related.chunks.length} chunk(s) (${d.related.ms} ms)\n`);
            break;
          case "versions":
            if (options.versionChunks > 0) live(`[4c] other versions: ${d.versions.chunks.length} chunk(s) (${d.versions.ms} ms)\n`);
            break;
          case "resolved":
            live(`[4] off-topic filter${options.rerank ? ` (rerank < ${options.rerank.minScore})` : ""}: dropped ${d.offTopic.length} chunk(s)\n[5] authority:\n`);
            for (const e of d.evidence) {
              live(`      ${e.priority}. ${e.id} ${e.role.padEnd(10)} ${e.documentId} v${e.version} "${e.title}"${e.note ? `  (${e.note})` : ""}\n`);
            }
            break;
          case "prompted":
            live(`[6] prompt built (${d.prompt!.system.length + d.prompt!.user.length} chars)\n`);
            break;
          case "generating":
            attempt++;
            reasoning[attempt] = "";
            phase = null;
            elapsed();
            live(`[7] calling ${llmId}...\n`);
            break;
        }
      },
      onDelta: (kind, text) => {
        if (kind === "reasoning") reasoning[attempt] += text;
        if (phase !== kind) {
          live(kind === "reasoning" ? "\n    thinking: " : "\n    output:   ");
          phase = kind;
        }
        live(kind === "reasoning" ? text.replace(/\s+/g, " ") : text);
      },
    });

    if (result.debug.generations.length > 0) live(`\n\n[8] finalized (${elapsed()} since the model started)\n`);

    await mkdir(dirname(tracePath), { recursive: true });
    await writeFile(
      tracePath,
      formatTrace(
        {
          startedAt,
          user: { id: user.user_id, groups: user.groups },
          question,
          options,
          embedding: { modelId: embeddings.modelId, prefixScheme: embeddings.prefixScheme },
          llm: { modelId: llmId, baseUrl: config.llm.baseUrl },
          reasoning,
        },
        result,
      ),
      "utf8",
    );

    if (values.json) {
      console.log(JSON.stringify(result.answer, null, 2));
    } else {
      console.log(`\n${"=".repeat(78)}\n${formatAnswer(result.answer)}\n${"=".repeat(78)}`);
    }
    live(`\nFull trace (every step + prompt): ${relative(process.cwd(), tracePath)}\n\n`);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\nask failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
