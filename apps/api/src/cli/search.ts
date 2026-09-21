import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { parseArgs } from "node:util";
import { AppModule } from "../app.module.js";
import type { AccessScope, Status } from "../domain/types.js";
import { EmbeddingPort } from "../ports/embedding.port.js";
import { VectorStorePort } from "../ports/vector-store.port.js";
import { PackLoader } from "../modules/corpus/pack.loader.js";

/**
 * Smoke search from the command line, as a given user.
 *
 *   node dist/cli/search.js --user u-eng-104 "how much annual leave do I get"
 *   node dist/cli/search.js --user u-proc-310 --order precedence "vendor approval process"
 *   node dist/cli/search.js --user u-proc-310 --as-of 2026-06-30 "vendor approval process"
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
      statuses: { type: "string", default: "current" },
      "min-rank": { type: "string", default: "0" },
      "min-cosine": { type: "string" },
      "as-of": { type: "string" },
      "max-chars": { type: "string", default: "10000" },
    },
  });

  const question = positionals.join(" ").trim();
  if (!values.user || question.length === 0) {
    throw new Error(
      'Usage: search --user <user_id> [--k 5] [--order relevance|precedence] [--statuses current,superseded,retired] [--min-rank N] [--min-cosine 0.0-1.0] [--as-of YYYY-MM-DD] [--max-chars N] "question"',
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

    const results = await app.get(VectorStorePort).search(scope, {
      text: question,
      embedding: embedding!,
      topK: Number(values.k),
      includeStatuses: values.statuses!.split(",") as Status[],
      minAuthorityRank: minRank,
      minCosine,
      asOf: values["as-of"],
      orderBy: values.order === "precedence" ? "precedence" : "relevance",
    });

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
          `   score=${r.score.toFixed(4)} cosine=${r.cosine === null ? "n/a" : r.cosine.toFixed(4)}\n` +
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
