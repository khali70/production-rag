import { z } from "zod";

/**
 * Single validation layer for process.env.
 *
 * Every variable is required. Nothing environment-specific (URLs, paths,
 * credentials) gets a default, so a missing value fails at startup with a
 * named error instead of letting `undefined` reach a query or a fetch.
 */
const bool = z
  .enum(["true", "false"])
  .transform((v) => v === "true");

const port = z.coerce.number().int().min(1).max(65535);

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: port,

  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_HOST_PORT: port,
  DATABASE_URL: z.string().startsWith("postgres"),
  TEST_DATABASE_URL: z.string().startsWith("postgres"),

  PACK_DIR: z.string().min(1),
  AUTHORITY_FILE: z.string().min(1),

  /** "fake" is a deterministic hash embedder for tests. Changing provider or model needs a re-ingest. */
  EMBEDDING_PROVIDER: z.enum(["transformers", "fake"]),
  EMBEDDING_MODEL_ID: z.string().min(1),
  EMBEDDING_DIM: z.coerce.number().int().positive(),
  /**
   * Instruction put before every query (never before documents), joined with one space.
   * Model specific: "query:" for snowflake-arctic-embed v2.0, "Represent this sentence for
   * searching relevant passages:" for bge-v1.5 / arctic v1.5. Empty for models without one.
   */
  EMBEDDING_QUERY_PREFIX: z.string(),
  EMBEDDING_DTYPE: z.enum(["fp32", "fp16", "q8", "int8", "uint8", "q4"]),
  EMBEDDING_CACHE_DIR: z.string().min(1),
  EMBEDDING_ALLOW_REMOTE: bool,

  /** Cross-encoder for optional reranking. Shares EMBEDDING_CACHE_DIR and EMBEDDING_ALLOW_REMOTE. */
  RERANKER_PROVIDER: z.enum(["transformers", "fake"]),
  RERANKER_MODEL_ID: z.string().min(1),
  RERANKER_DTYPE: z.enum(["fp32", "fp16", "q8", "int8", "uint8", "q4"]),

  PURGE_RETENTION_DAYS: z.coerce.number().int().nonnegative(),

  LLM_PROVIDER: z.enum(["openai-compat", "fake"]),
  /** OpenAI-compatible base URL without the /v1 suffix, e.g. http://localhost:11434 for Ollama. */
  LLM_BASE_URL: z.url(),
  LLM_MODEL_ID: z.string().min(1),
  /** Empty for local Ollama. Required by hosted providers; never defaulted. */
  LLM_API_KEY: z.string(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive(),
  LLM_MAX_TOKENS: z.coerce.number().int().positive(),
  /** Qwen3-style hybrid thinking models: send /no_think and strip <think> blocks. */
  LLM_DISABLE_THINKING: bool,
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parses and returns the validated environment, or throws an Error naming
 * every offending variable at once.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (result.success) return result.data;

  const problems = result.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  throw new Error(
    `Invalid environment. Fix these variables (see .env.example):\n${problems}`,
  );
}
