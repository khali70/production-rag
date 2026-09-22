import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { FakeEmbeddingAdapter } from "../../src/adapters/embedding/fake-embedding.adapter.js";
import { PgVectorStoreAdapter } from "../../src/adapters/vector-store/pgvector/pgvector.adapter.js";
import { PgPool } from "../../src/adapters/vector-store/pgvector/pg.pool.js";
import { AppConfig } from "../../src/config/app-config.js";
import { validateEnv } from "../../src/config/env.schema.js";
import { describeVectorStoreContract, type ContractHarness } from "./vector-store.contract.js";
import { ENGINEER, VECTOR_DIM, makeChunk, unitVector } from "./fixtures.js";

const ROOT = resolve(import.meta.dirname, "../../../..");
const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../migrations");

/** Reads the committed .env, the same file the CLIs use, then forces test mode. */
function testConfig(): AppConfig {
  const file = readFileSync(resolve(ROOT, ".env"), "utf8");
  const raw: Record<string, string> = {};
  for (const line of file.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) raw[match[1]!] = match[2]!;
  }
  return new AppConfig(validateEnv({ ...raw, NODE_ENV: "test" }));
}

async function makeHarness(): Promise<ContractHarness> {
  const config = testConfig();
  const embeddings = new FakeEmbeddingAdapter(config.embedding.dim);

  // The contract suite owns its database, so it builds the schema itself
  // rather than depending on a migration having been run by hand.
  const bootstrap = new pg.Client({ connectionString: config.databaseUrl });
  await bootstrap.connect();
  await bootstrap.query("CREATE EXTENSION IF NOT EXISTS vector");
  await bootstrap.query("DROP TABLE IF EXISTS chunks, documents, index_meta CASCADE");
  // Every migration in filename order, like the Migrator: later ones change the schema (e.g. vector dim).
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    await bootstrap.query(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  await bootstrap.end();

  const pool = new PgPool(config);
  const store = new PgVectorStoreAdapter(pool, embeddings);

  return {
    store,
    embeddings,
    reset: async () => {
      await pool.pool.query("TRUNCATE chunks, documents, index_meta CASCADE");
    },
    close: async () => {
      await pool.onModuleDestroy();
    },
  };
}

describeVectorStoreContract("pgvector", makeHarness);

/**
 * Checks that are specific to this adapter's schema rather than part of the
 * portable contract.
 */
describe("pgvector adapter specifics", () => {
  it("registers the vector type so embeddings round-trip as numbers", async () => {
    const harness = await makeHarness();
    try {
      await harness.reset();
      const embedding = unitVector(7);
      await harness.store.upsert([makeChunk({ documentId: "ROUNDTRIP", embedding })]);

      const { rows } = await (harness.store as unknown as { db: PgPool }).db.query<{
        embedding: number[];
      }>("SELECT embedding FROM chunks WHERE document_id = 'ROUNDTRIP'");

      expect(Array.isArray(rows[0]!.embedding)).toBe(true);
      expect(rows[0]!.embedding).toHaveLength(VECTOR_DIM);
      expect(rows[0]!.embedding[7]).toBeCloseTo(1, 5);
    } finally {
      await harness.close();
    }
  });

  it("moves updated_at on a change but leaves created_at alone", async () => {
    const harness = await makeHarness();
    try {
      await harness.reset();
      await harness.store.upsert([makeChunk({ documentId: "STAMPED" })]);

      const pool = (harness.store as unknown as { db: PgPool }).db.pool;
      const before = await pool.query<{ created_at: Date; updated_at: Date }>(
        "SELECT created_at, updated_at FROM documents WHERE document_id = 'STAMPED'",
      );

      await new Promise((r) => setTimeout(r, 20));
      await harness.store.setDocStatus("STAMPED", "1.0", "retired");

      const after = await pool.query<{ created_at: Date; updated_at: Date }>(
        "SELECT created_at, updated_at FROM documents WHERE document_id = 'STAMPED'",
      );

      expect(after.rows[0]!.created_at.getTime()).toBe(before.rows[0]!.created_at.getTime());
      expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThan(
        before.rows[0]!.updated_at.getTime(),
      );
    } finally {
      await harness.close();
    }
  });

  it("refuses at the database level to mark an unverified document as trusted", async () => {
    const harness = await makeHarness();
    try {
      await harness.reset();
      // The CHECK constraint is the last line of defense: even a bug in the
      // ingest path cannot store an unverified document as normal trust.
      const pool = (harness.store as unknown as { db: PgPool }).db.pool;
      await expect(
        pool.query(
          `INSERT INTO documents (
             document_id, version, title, source_path, content_sha256,
             allowed_groups, classification, classification_groups, deny_groups,
             tier, authority_rank, level, owner, relations,
             status, raw_status, effective_from, trust
           ) VALUES ('BAD','1.0','t','p','h','{}','INTERNAL','{}','{}',
                     'unverified',10,1,'o','[]','current','Unverified','2026-01-01','normal')`,
        ),
      ).rejects.toThrow(/unverified_is_low_trust/);
    } finally {
      await harness.close();
    }
  });

  it("cascades chunk deletion when a document row is purged", async () => {
    const harness = await makeHarness();
    try {
      await harness.reset();
      await harness.store.upsert([
        makeChunk({ documentId: "CASCADE", chunkIndex: 0 }),
        makeChunk({ documentId: "CASCADE", chunkIndex: 1 }),
      ]);
      await harness.store.softDeleteDoc("CASCADE", "u", "r", new Date("2026-01-01T00:00:00Z"));
      await harness.store.purgeDeleted(new Date("2026-06-01T00:00:00Z"));

      const pool = (harness.store as unknown as { db: PgPool }).db.pool;
      const { rows } = await pool.query("SELECT 1 FROM chunks WHERE document_id = 'CASCADE'");
      expect(rows).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("applies the same access filter to the full-text leg as to the vector leg", async () => {
    const harness = await makeHarness();
    try {
      await harness.reset();
      // A restricted document whose text matches the query exactly. If the
      // filter were missing from either leg, it would surface here.
      await harness.store.upsert([
        makeChunk({
          documentId: "SECRET",
          text: "administrative leave investigation employee E-8841 mailbox access",
          classification: "RESTRICTED_HR_INVESTIGATION",
          allowedGroups: ["hr_investigations"],
          classificationGroups: ["hr_investigations"],
          denyGroups: ["engineering"],
        }),
      ]);

      const results = await harness.store.search(ENGINEER, {
        text: "administrative leave investigation employee E-8841 mailbox access",
        embedding: unitVector(0),
        topK: 20,
      });
      expect(results).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});
