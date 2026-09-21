import { Inject, Injectable, Logger } from "@nestjs/common";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PgPool } from "./pg.pool.js";

/** migrations/ sits next to dist/, one level up from the compiled file. */
const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../../../migrations");

/**
 * Minimal forward-only migration runner. Each file runs once, inside its own
 * transaction, in filename order.
 */
@Injectable()
export class Migrator {
  private readonly logger = new Logger(Migrator.name);

  constructor(@Inject(PgPool) private readonly db: PgPool) {}

  async run(): Promise<string[]> {
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name       text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const { rows } = await this.db.query<{ name: string }>("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.name));

    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(resolve(MIGRATIONS_DIR, file), "utf8");
      await this.db.transaction(async (client) => {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      });
      this.logger.log(`applied ${file}`);
      ran.push(file);
    }

    if (ran.length === 0) this.logger.log("schema up to date");
    return ran;
  }
}
