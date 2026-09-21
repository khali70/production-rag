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
      "as-of": { type: "string" },
    },
  });

  const question = positionals.join(" ").trim();
  if (!values.user || question.length === 0) {
    throw new Error('Usage: search --user <user_id> [--k 5] [--order relevance|precedence] [--as-of YYYY-MM-DD] "question"');
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
      minAuthorityRank: Number(values["min-rank"]),
      asOf: values["as-of"],
      orderBy: values.order === "precedence" ? "precedence" : "relevance",
    });

    console.log(`\n${user.user_id} (${user.groups.join(", ")}) asked: ${question}\n`);
    if (results.length === 0) {
      console.log("no visible chunks matched");
      return;
    }
    for (const [i, r] of results.entries()) {
      console.log(
        `${i + 1}. ${r.source.documentId} v${r.source.version} [${r.source.sectionPath.join(" > ")}]\n` +
          `   tier=${r.tier} level=${r.level} rank=${r.authorityRank} status=${r.status} trust=${r.trust}\n` +
          `   score=${r.score.toFixed(4)} cosine=${r.cosine === null ? "n/a" : r.cosine.toFixed(4)}\n` +
          `   ${r.text.replace(/\s+/g, " ").slice(0, 160)}...\n`,
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
