import { Inject, Injectable } from "@nestjs/common";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { AppConfig } from "../../config/app-config.js";
import { TIERS } from "../../domain/tier.js";
import type { Relation, Tier } from "../../domain/types.js";

const relationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("supersedes"),
    document_id: z.string(),
    version: z.string(),
  }),
  z.object({
    kind: z.literal("amends"),
    document_id: z.string(),
    version: z.string(),
    scope: z.string().min(1),
  }),
  z.object({
    kind: z.literal("qualifies"),
    document_id: z.string(),
    version: z.string(),
    scope: z.string().min(1),
  }),
]);

const entrySchema = z.object({
  document_id: z.string().min(1),
  version: z.string().min(1),
  tier: z.enum(TIERS as [Tier, ...Tier[]]),
  /** 0 is company-wide. Lower wins a conflict. */
  level: z.number().int().min(0).max(9),
  owner: z.string().min(1),
  /** Required when the document text carries no Owner cue of its own. */
  owner_inferred: z.boolean().optional(),
  relations: z.array(relationSchema).default([]),
  /** Quotes from the document's own content that justify the entry. */
  evidence: z.array(z.string().min(1)).min(1),
  delegation_evidence: z
    .object({ document_id: z.string(), version: z.string(), quote: z.string().min(1) })
    .optional(),
});

export const authorityFileSchema = z.object({
  schema_version: z.string(),
  levels: z.record(z.string(), z.string()).optional(),
  documents: z.array(entrySchema).min(1),
});

export type AuthorityEntry = z.infer<typeof entrySchema>;
export type AuthorityFile = z.infer<typeof authorityFileSchema>;

/** Keyed lookup: one entry per (document_id, version). */
export type AuthorityIndex = Map<string, AuthorityEntry>;

export function authorityKey(documentId: string, version: string): string {
  return `${documentId}@${version}`;
}

export function toRelations(entry: AuthorityEntry): Relation[] {
  return entry.relations.map((r) =>
    r.kind === "supersedes"
      ? { kind: "supersedes", documentId: r.document_id, version: r.version }
      : { kind: r.kind, documentId: r.document_id, version: r.version, scope: r.scope },
  );
}

@Injectable()
export class AuthorityLoader {
  constructor(@Inject(AppConfig) private readonly config: AppConfig) {}

  async load(): Promise<{ file: AuthorityFile; index: AuthorityIndex }> {
    const raw = await readFile(this.config.authorityFile, "utf8");
    const file = authorityFileSchema.parse(parse(raw));

    const index: AuthorityIndex = new Map();
    for (const entry of file.documents) {
      const key = authorityKey(entry.document_id, entry.version);
      if (index.has(key)) {
        throw new Error(`Duplicate authority entry for ${key} in ${this.config.authorityFile}.`);
      }
      index.set(key, entry);
    }

    return { file, index };
  }
}
