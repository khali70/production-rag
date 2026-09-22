import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { parseArgs } from "node:util";
import { AppModule } from "../app.module.js";
import type { AccessScope, Status } from "../domain/types.js";
import { EmbeddingPort } from "../ports/embedding.port.js";
import { VectorStorePort } from "../ports/vector-store.port.js";
import { PackLoader } from "../modules/corpus/pack.loader.js";
import { RerankerPort } from "../ports/reranker.port.js";
import { comparePrecedence } from "../domain/precedence.js";

/**
 * Smoke search from the command line, as a given user.
 *
 *   node dist/cli/search.js --user u-eng-104 "how much annual leave do I get"
 *   node dist/cli/search.js --user u-proc-310 --order precedence "vendor approval process"
 *   node dist/cli/search.js --user u-proc-310 --as-of 2026-06-30 "vendor approval process"
 *   node dist/cli/search.js --user u-proc-310 --rerank "who approves a 40k vendor"
 *
 * Groups are resolved server-side from the pack's identities.json, never taken
 * from the caller, which is the same rule the HTTP layer will follow.
 */
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      user: { type: "string" },
      k: { type: "string", default: "5" },
      order: { type: "string", default: "relevance" },
      statuses: { type: "string", default: "current,superseded,retired" },
      "min-rank": { type: "string", default: "0" },
      "min-cosine": { type: "string" },
      "as-of": { type: "string" },
      "max-chars": { type: "string", default: "10000" },
      rerank: { type: "boolean", default: false },
      "rerank-pool": { type: "string", default: "20" },
    },
  });

  const question = positionals.join(" ").trim();
  if (!values.user || question.length === 0) {
    throw new Error(
      'Usage: search --user <user_id> [--k 5] [--order relevance|precedence] [--statuses current,superseded,retired] [--min-rank N] [--min-cosine 0.0-1.0] [--as-of YYYY-MM-DD] [--max-chars N] [--rerank] [--rerank-pool 20] "question"',
    );
  }

  const minRank = Number(values["min-rank"]);
  if (!Number.isInteger(minRank) || minRank < 0) {
    throw new Error(`--min-rank must be a non-negative integer, got "${values["min-rank"]}"`);
  }

  const minCosine = values["min-cosine"] === undefined ? undefined : Number(values["min-cosine"]);
  if (minCosine !== undefined && !(minCosine >= -1 && minCosine <= 1)) {
    throw new Error(`--min-cosine must be a number between -1 and 1, got "${values["min-cosine"]}"`);
  }

  const k = Number(values.k);
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`--k must be a positive integer, got "${values.k}"`);
  }

  const rerankPool = Number(values["rerank-pool"]);
  if (!Number.isInteger(rerankPool) || rerankPool < k) {
    throw new Error(`--rerank-pool must be an integer >= --k (${k}), got "${values["rerank-pool"]}"`);
  }

  // 0 prints each chunk in full; N > 0 caps the preview at N chars.
  const maxChars = Number(values["max-chars"]);
  if (!Number.isInteger(maxChars) || maxChars < 0) {
    throw new Error(`--max-chars must be a non-negative integer, got "${values["max-chars"]}"`);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["warn", "error"] });

  try {
    const identities = await app.get(PackLoader).loadIdentities();
    const user = identities.users.find((u) => u.user_id === values.user);
    if (!user) throw new Error(`Unknown user ${values.user}. Identity lookup is server-side.`);

    const scope: AccessScope = {
      principalId: user.user_id,
      groups: user.groups,
      department: user.department,
    };

    const embeddings = app.get(EmbeddingPort);
    const [embedding] = await embeddings.embed([question], "query");

    const precedence = values.order === "precedence";

    // With --rerank, fetch a wider pool by relevance, rescore it with the
    // cross-encoder and keep the top k. Precedence is then applied only within
    // those k, so authority reorders relevant chunks instead of pushing
    // relevant lower-tier documents out of the result entirely.
    const candidates = await app.get(VectorStorePort).search(scope, {
      text: question,
      embedding: embedding!,
      topK: values.rerank ? rerankPool : k,
      includeStatuses: values.statuses!.split(",") as Status[],
      minAuthorityRank: minRank,
      minCosine,
      asOf: values["as-of"],
      orderBy: precedence && !values.rerank ? "precedence" : "relevance",
    });

    const rerankScores = new Map<string, number>();
    let results = candidates;
    if (values.rerank) {
      const started = Date.now();
      const scores = await app.get(RerankerPort).score(question, candidates.map((c) => c.text));
      candidates.forEach((c, i) => rerankScores.set(c.chunkId, scores[i]!));
      results = [...candidates]
        .sort((a, b) => rerankScores.get(b.chunkId)! - rerankScores.get(a.chunkId)!)
        .slice(0, k);
      if (precedence) {
        // comparePrecedence breaks ties on score, so feed it the rerank score.
        results = results
          .map((r) => ({ ...r, score: rerankScores.get(r.chunkId)! }))
          .sort(comparePrecedence)
          .map((r) => candidates.find((c) => c.chunkId === r.chunkId)!);
      }
      console.log(`reranked ${candidates.length} candidates in ${Date.now() - started} ms`);
    }

    console.log(`\n${user.user_id} (${user.groups.join(", ")}) asked: ${question}\n`);
    if (results.length === 0) {
      console.log("no visible chunks matched");
      return;
    }
    for (const [i, r] of results.entries()) {
      const text = r.text.replace(/\s+/g, " ").trim();
      const preview = maxChars > 0 && text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
      const { pageStart, pageEnd } = r.source;
      const pages =
        pageStart === undefined ? "" : pageEnd === undefined || pageEnd === pageStart ? ` p.${pageStart}` : ` pp.${pageStart}-${pageEnd}`;
      console.log(
        `${i + 1}. ${r.source.documentId} v${r.source.version} [${r.source.sectionPath.join(" > ")}]\n` +
          `   title=${r.source.title}\n` +
          `   source=${r.source.sourcePath}${pages} chars=${r.source.charStart}-${r.source.charEnd} chunk=${r.source.chunkIndex}\n` +
          `   tier=${r.tier} level=${r.level} rank=${r.authorityRank} status=${r.status} trust=${r.trust}\n` +
          `   score=${r.score.toFixed(4)} cosine=${r.cosine === null ? "n/a" : r.cosine.toFixed(4)}` +
          (rerankScores.has(r.chunkId) ? ` rerank=${rerankScores.get(r.chunkId)!.toFixed(4)}` : "") +
          "\n" +
        `   ${preview}\n`,
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\nsearch failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
