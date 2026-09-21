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
    provider: Env["EMBEDDING_PROVIDER"];
    modelId: string;
    dim: number;
    dtype: Env["EMBEDDING_DTYPE"];
    cacheDir: string;
    allowRemote: boolean;
  };

  readonly reranker: {
    provider: Env["RERANKER_PROVIDER"];
    modelId: string;
    dtype: Env["RERANKER_DTYPE"];
  };

  readonly purgeRetentionDays: number;

  readonly llm: {
    provider: Env["LLM_PROVIDER"];
    baseUrl: string;
    modelId: string;
    apiKey: string;
    timeoutMs: number;
    maxTokens: number;
    disableThinking: boolean;
  };

  constructor(env: Env) {
    this.nodeEnv = env.NODE_ENV;
    this.port = env.PORT;
    this.databaseUrl = env.NODE_ENV === "test" ? env.TEST_DATABASE_URL : env.DATABASE_URL;
    this.packDir = fromRoot(env.PACK_DIR);
    this.authorityFile = fromRoot(env.AUTHORITY_FILE);
    this.embedding = {
      provider: env.EMBEDDING_PROVIDER,
      modelId: env.EMBEDDING_MODEL_ID,
      dim: env.EMBEDDING_DIM,
      dtype: env.EMBEDDING_DTYPE,
      cacheDir: fromRoot(env.EMBEDDING_CACHE_DIR),
      allowRemote: env.EMBEDDING_ALLOW_REMOTE,
    };
    this.reranker = {
      provider: env.RERANKER_PROVIDER,
      modelId: env.RERANKER_MODEL_ID,
      dtype: env.RERANKER_DTYPE,
    };
    this.purgeRetentionDays = env.PURGE_RETENTION_DAYS;
    this.llm = {
      provider: env.LLM_PROVIDER,
      baseUrl: env.LLM_BASE_URL.replace(/\/+$/, ""),
      modelId: env.LLM_MODEL_ID,
      apiKey: env.LLM_API_KEY,
      timeoutMs: env.LLM_TIMEOUT_MS,
      maxTokens: env.LLM_MAX_TOKENS,
      disableThinking: env.LLM_DISABLE_THINKING,
    };
  }
}
