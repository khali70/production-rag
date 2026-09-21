import { Inject, Injectable } from "@nestjs/common";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { AppConfig } from "../../config/app-config.js";

/**
 * Reads the supplied assessment pack. Everything is schema-validated on the way
 * in: a pack that does not match what we expect stops ingest rather than
 * producing half-mapped metadata.
 *
 * The pack is read-only. Nothing here writes back to it.
 */

export const corpusRecordSchema = z.object({
  schema_version: z.string(),
  document_id: z.string().min(1),
  title: z.string().min(1),
  version: z.string().min(1),
  status: z.string().min(1),
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  classification: z.string().min(1),
  allowed_groups: z.array(z.string()),
  source_path: z.string().min(1),
  content: z.string().min(1),
});
export type CorpusRecord = z.infer<typeof corpusRecordSchema>;

export const entitlementsSchema = z.object({
  schema_version: z.string(),
  default_rule: z.literal("deny"),
  rules: z.array(
    z.object({
      rule_id: z.string(),
      classification: z.string(),
      allow_groups: z.array(z.string()),
    }),
  ),
  document_overrides: z
    .array(
      z.object({
        document_id: z.string(),
        allow_groups: z.array(z.string()).optional(),
        deny_groups: z.array(z.string()).optional(),
      }),
    )
    .default([]),
});
export type Entitlements = z.infer<typeof entitlementsSchema>;

export const identitiesSchema = z.object({
  schema_version: z.string().optional(),
  users: z.array(
    z.object({
      user_id: z.string(),
      display_name: z.string().optional(),
      department: z.string(),
      roles: z.array(z.string()).optional(),
      groups: z.array(z.string()),
    }),
  ),
});
export type Identities = z.infer<typeof identitiesSchema>;

@Injectable()
export class PackLoader {
  constructor(@Inject(AppConfig) private readonly config: AppConfig) {}

  path(...parts: string[]): string {
    return resolve(this.config.packDir, ...parts);
  }

  async loadCorpus(): Promise<CorpusRecord[]> {
    const raw = await readFile(this.path("normalized", "corpus.jsonl"), "utf8");
    const records: CorpusRecord[] = [];

    raw.split("\n").forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error(`corpus.jsonl line ${i + 1} is not valid JSON.`);
      }
      const result = corpusRecordSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(`corpus.jsonl line ${i + 1} failed validation: ${result.error.message}`);
      }
      records.push(result.data);
    });

    if (records.length === 0) throw new Error("corpus.jsonl is empty.");
    return records;
  }

  async loadEntitlements(): Promise<Entitlements> {
    const raw = await readFile(this.path("access", "entitlements.json"), "utf8");
    return entitlementsSchema.parse(JSON.parse(raw));
  }

  async loadIdentities(): Promise<Identities> {
    const raw = await readFile(this.path("access", "identities.json"), "utf8");
    return identitiesSchema.parse(JSON.parse(raw));
  }
}
