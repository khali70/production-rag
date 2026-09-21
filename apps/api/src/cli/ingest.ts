import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { parseArgs } from "node:util";
import { AppModule } from "../app.module.js";
import { IngestService } from "../modules/corpus/ingest.service.js";

/**
 * Loads the assessment pack into the vector store.
 *
 *   --reindex   re-embed every document (required after an embedding change)
 *   --dry-run   run every check, write nothing
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      reindex: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["log", "warn", "error"],
  });

  try {
    const report = await app.get(IngestService).run({
      reindex: values.reindex,
      dryRun: values["dry-run"],
    });

    console.log(
      [
        "",
        `pack files verified : ${report.filesVerified}`,
        `documents           : ${report.documents}`,
        `written             : ${report.written}`,
        `unchanged (skipped) : ${report.skipped}`,
        `chunks              : ${report.chunks}`,
        `trust low           : ${report.lowTrust.length > 0 ? report.lowTrust.join(", ") : "none"}`,
        values["dry-run"] ? "\nDRY RUN: nothing was written." : "",
      ].join("\n"),
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\ningest failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
