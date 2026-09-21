import { Injectable } from "@nestjs/common";
import { resolve } from "node:path";
import type { Env } from "./env.schema.js";

/** Repo root, derived from this file's location (apps/api/src/config -> ../../../..). */
export const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

/** Resolves a configured path against the repo root when it is relative. */
function fromRoot(p: string): string {
  return resolve(REPO_ROOT, p);
}

@Injectable()
export class AppConfig {
  readonly nodeEnv: Env["NODE_ENV"];
  readonly port: number;

  /** Contract tests point at TEST_DATABASE_URL; everything else at DATABASE_URL. */
  readonly databaseUrl: string;

  readonly packDir: string;
  readonly authorityFile: string;

  readonly embedding: {
    modelId: string;
    dim: number;
    dtype: Env["EMBEDDING_DTYPE"];
    cacheDir: string;
    allowRemote: boolean;
  };

  readonly purgeRetentionDays: number;

  constructor(env: Env) {
    this.nodeEnv = env.NODE_ENV;
    this.port = env.PORT;
    this.databaseUrl = env.NODE_ENV === "test" ? env.TEST_DATABASE_URL : env.DATABASE_URL;
    this.packDir = fromRoot(env.PACK_DIR);
    this.authorityFile = fromRoot(env.AUTHORITY_FILE);
    this.embedding = {
      modelId: env.EMBEDDING_MODEL_ID,
      dim: env.EMBEDDING_DIM,
      dtype: env.EMBEDDING_DTYPE,
      cacheDir: fromRoot(env.EMBEDDING_CACHE_DIR),
      allowRemote: env.EMBEDDING_ALLOW_REMOTE,
    };
    this.purgeRetentionDays = env.PURGE_RETENTION_DAYS;
  }
}
