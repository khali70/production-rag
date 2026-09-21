import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module.js";
import { Migrator } from "../adapters/vector-store/pgvector/migrate.js";

/** Applies pending SQL migrations, then exits. */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["log", "warn", "error"],
  });
  try {
    const ran = await app.get(Migrator).run();
    console.log(ran.length > 0 ? `applied ${ran.length} migration(s)` : "no pending migrations");
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
