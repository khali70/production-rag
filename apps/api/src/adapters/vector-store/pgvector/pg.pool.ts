import { Inject, Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import pg from "pg";
import { AppConfig } from "../../../config/app-config.js";

/**
 * Shared connection pool.
 *
 * The `vector` type parser is installed once, globally, from the type's OID.
 * pgvector's own registerTypes() runs a query on every new connection, which
 * both costs a round trip per connection and races the pool handing that same
 * client to the caller.
 */
let vectorTypeRegistered = false;

function parseVector(value: string): number[] {
  // Wire format is "[1,2,3]".
  return value
    .slice(1, -1)
    .split(",")
    .map(Number);
}

@Injectable()
export class PgPool implements OnModuleDestroy {
  private readonly logger = new Logger(PgPool.name);
  readonly pool: pg.Pool;
  private registering: Promise<void> | null = null;

  constructor(@Inject(AppConfig) config: AppConfig) {
    this.pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
    this.pool.on("error", (err) => this.logger.error(`idle client error: ${err.message}`));
  }

  /**
   * Looks the vector OID up once and installs a global parser, so vector
   * columns arrive as number[] instead of a string.
   * Tolerates a database where the extension is not installed yet: the first
   * migration creates it, and the next call registers the parser.
   */
  private async ensureVectorType(): Promise<void> {
    if (vectorTypeRegistered) return;
    this.registering ??= (async () => {
      const { rows } = await this.pool.query<{ oid: number }>(
        "SELECT oid FROM pg_type WHERE typname = 'vector'",
      );
      if (rows.length === 0) {
        this.logger.debug("vector type not present yet; run migrations");
        return;
      }
      pg.types.setTypeParser(rows[0]!.oid, parseVector);
      vectorTypeRegistered = true;
    })();

    try {
      await this.registering;
    } finally {
      this.registering = null;
    }
  }

  async query<T extends pg.QueryResultRow>(
    sql: string,
    args: unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    await this.ensureVectorType();
    return this.pool.query<T>(sql, args);
  }

  /**
   * Runs `fn` on one checked-out client inside a transaction.
   * Session settings must use SET LOCAL: a plain SET on a pooled connection
   * leaks into whatever query borrows that connection next.
   */
  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    await this.ensureVectorType();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
