import { rankOf } from "../../src/domain/tier.js";
import type { AccessScope, ChunkRecord, Status, Tier } from "../../src/domain/types.js";

/** The three users from the pack's identities.json. */
export const ENGINEER: AccessScope = {
  principalId: "u-eng-104",
  groups: ["all_employees", "engineering"],
  department: "Engineering",
};

export const HR: AccessScope = {
  principalId: "u-hr-207",
  groups: ["all_employees", "hr_general", "hr_investigations"],
  department: "Human Resources",
};

export const PROCUREMENT: AccessScope = {
  principalId: "u-proc-310",
  groups: ["all_employees", "procurement"],
  department: "Procurement",
};

export type ChunkOverrides = {
  documentId?: string;
  version?: string;
  chunkIndex?: number;
  text?: string;
  tier?: Tier;
  level?: number;
  status?: Status;
  trust?: "normal" | "low";
  allowedGroups?: string[];
  classification?: string;
  classificationGroups?: string[];
  denyGroups?: string[];
  effectiveFrom?: string;
  relations?: ChunkRecord["relations"];
  embedding?: number[];
};

/**
 * Builds a chunk with sane defaults: visible to everyone, current, normal
 * trust. Each test overrides only the field it is about.
 */
export function makeChunk(overrides: ChunkOverrides = {}): ChunkRecord {
  const documentId = overrides.documentId ?? "DOC-1";
  const version = overrides.version ?? "1.0";
  const chunkIndex = overrides.chunkIndex ?? 0;
  const tier = overrides.tier ?? "policy";

  return {
    chunkId: `${documentId}@${version}#${chunkIndex}`,
    text: overrides.text ?? "vendor approval process requires finance and legal review",
    embedding: overrides.embedding ?? unitVector(chunkIndex),
    contentSha256: `sha-${documentId}-${version}`,
    source: {
      documentId,
      version,
      title: `Title of ${documentId}`,
      sourcePath: `corpus/public/${documentId}.pdf`,
      sectionPath: ["Document"],
      charStart: 0,
      charEnd: 10,
      chunkIndex,
    },
    allowedGroups: overrides.allowedGroups ?? ["all_employees"],
    classification: overrides.classification ?? "INTERNAL",
    classificationGroups: overrides.classificationGroups ?? ["all_employees"],
    denyGroups: overrides.denyGroups ?? [],
    tier,
    authorityRank: rankOf(tier),
    level: overrides.level ?? 1,
    owner: "Test Owner",
    relations: overrides.relations ?? [],
    status: overrides.status ?? "current",
    rawStatus: overrides.status ?? "Current",
    effectiveFrom: overrides.effectiveFrom ?? "2026-01-01",
    trust: overrides.trust ?? "normal",
  };
}

/** Distinct unit vectors, so ordering assertions are not accidentally tied. */
export function unitVector(seed: number, dim = 384): number[] {
  const v = new Array<number>(dim).fill(0);
  v[seed % dim] = 1;
  return v;
}
