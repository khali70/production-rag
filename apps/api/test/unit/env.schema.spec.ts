import { describe, expect, it } from "vitest";
import { validateEnv } from "../../src/config/env.schema.js";

const valid = {
  NODE_ENV: "test",
  PORT: "3001",
  POSTGRES_USER: "rag",
  POSTGRES_PASSWORD: "secret",
  POSTGRES_DB: "rag",
  POSTGRES_HOST_PORT: "5435",
  DATABASE_URL: "postgres://rag:secret@localhost:5435/rag",
  TEST_DATABASE_URL: "postgres://rag:secret@localhost:5435/rag_test",
  PACK_DIR: "Kentrick_Assessment_Pack_Candidate",
  AUTHORITY_FILE: "data/authority.yaml",
  EMBEDDING_MODEL_ID: "Xenova/bge-small-en-v1.5",
  EMBEDDING_DIM: "384",
  EMBEDDING_DTYPE: "fp32",
  EMBEDDING_CACHE_DIR: ".cache/models",
  EMBEDDING_ALLOW_REMOTE: "true",
  PURGE_RETENTION_DAYS: "30",
};

describe("env schema", () => {
  it("coerces numbers and booleans", () => {
    const env = validateEnv(valid);
    expect(env.EMBEDDING_DIM).toBe(384);
    expect(env.PORT).toBe(3001);
    expect(env.EMBEDDING_ALLOW_REMOTE).toBe(true);
  });

  it("names every missing variable instead of failing on the first one", () => {
    const { DATABASE_URL, EMBEDDING_DIM, ...rest } = valid;
    void DATABASE_URL;
    void EMBEDDING_DIM;
    try {
      validateEnv(rest);
      expect.unreachable("expected validateEnv to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("DATABASE_URL");
      expect(message).toContain("EMBEDDING_DIM");
    }
  });

  it("rejects a database url that is not postgres", () => {
    expect(() => validateEnv({ ...valid, DATABASE_URL: "mysql://localhost/rag" })).toThrow(
      /DATABASE_URL/,
    );
  });

  it("rejects an unsupported dtype rather than silently accepting it", () => {
    expect(() => validateEnv({ ...valid, EMBEDDING_DTYPE: "bf16" })).toThrow(/EMBEDDING_DTYPE/);
  });
});
