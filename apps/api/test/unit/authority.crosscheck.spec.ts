import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import {
  AuthorityCrossCheck,
  AuthorityMismatchError,
} from "../../src/modules/corpus/authority.crosscheck.js";
import {
  authorityFileSchema,
  authorityKey,
  type AuthorityEntry,
  type AuthorityIndex,
} from "../../src/modules/corpus/authority.loader.js";
import { corpusRecordSchema, type CorpusRecord } from "../../src/modules/corpus/pack.loader.js";

const ROOT = resolve(import.meta.dirname, "../../../..");
const PACK = resolve(ROOT, "Kentrick_Assessment_Pack_Candidate");

function loadRecords(): CorpusRecord[] {
  return readFileSync(resolve(PACK, "normalized/corpus.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => corpusRecordSchema.parse(JSON.parse(l)));
}

function loadIndex(): AuthorityIndex {
  const file = authorityFileSchema.parse(parse(readFileSync(resolve(ROOT, "data/authority.yaml"), "utf8")));
  return new Map(file.documents.map((e) => [authorityKey(e.document_id, e.version), e]));
}

/** Deep copy so a mutation test cannot leak into the next one. */
function mutate(index: AuthorityIndex, key: string, patch: Partial<AuthorityEntry>): AuthorityIndex {
  const copy: AuthorityIndex = new Map(
    [...index].map(([k, v]) => [k, JSON.parse(JSON.stringify(v)) as AuthorityEntry]),
  );
  copy.set(key, { ...copy.get(key)!, ...patch });
  return copy;
}

describe("authority cross-check", () => {
  const records = loadRecords();
  const index = loadIndex();
  const check = new AuthorityCrossCheck();

  it("accepts the committed authority.yaml against the supplied pack", () => {
    expect(() => check.check(records, index)).not.toThrow();
    expect(() => check.checkDelegationQuotes(records, index)).not.toThrow();
  });

  it("assigns every corpus document a reviewed tier and level", () => {
    for (const record of records) {
      const entry = index.get(authorityKey(record.document_id, record.version));
      expect(entry, `${record.document_id} v${record.version}`).toBeDefined();
      expect(entry!.level).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects an evidence quote that is not in the document", () => {
    const tampered = mutate(index, "APX-HR-POL-003@4.2", {
      evidence: ["Owner | Department of Invented Things"],
    });
    expect(() => check.check(records, tampered)).toThrow(AuthorityMismatchError);
  });

  it("rejects an owner that contradicts the document text", () => {
    const tampered = mutate(index, "APX-PROC-POL-014@3.0", { owner: "Engineering" });
    expect(() => check.check(records, tampered)).toThrow(/content says owner/);
  });

  it("requires owner_inferred when the document states no owner", () => {
    const tampered = mutate(index, "APX-LEG-CON-NS-2026@1.0", { owner_inferred: false });
    expect(() => check.check(records, tampered)).toThrow(/owner_inferred/);
  });

  it("rejects dropping the supersedes relation the policy text states", () => {
    const tampered = mutate(index, "APX-PROC-POL-014@3.0", { relations: [] });
    expect(() => check.check(records, tampered)).toThrow(/supersedes version 2.1/);
  });

  it("rejects a supersede the memo explicitly disclaims", () => {
    // The memo says it "does not supersede APX-PROC-POL-014". Claiming
    // otherwise in the reviewed layer must fail the ingest.
    const tampered = mutate(index, "APX-LEGAL-MEM-027@1.0", {
      relations: [{ kind: "supersedes", document_id: "APX-PROC-POL-014", version: "3.0" }],
    });
    expect(() => check.check(records, tampered)).toThrow(/does not supersede/);
  });

  it("does not mistake the matrix scope sentence for a version supersede", () => {
    // MTX-006 says it "supersedes threshold tables embedded in earlier policy
    // copies". That is a scope statement, not a version supersede, and must
    // not force a supersedes relation.
    expect(() => check.check(records, index)).not.toThrow();
    expect(index.get("APX-PROC-MTX-006@1.2")!.relations[0]!.kind).toBe("amends");
  });

  it("requires a scoped relation when a document names a related policy", () => {
    const tampered = mutate(index, "APX-PROC-MTX-006@1.2", { relations: [] });
    expect(() => check.check(records, tampered)).toThrow(/names related policy/);
  });

  it("rejects a relation pointing at a document that is not in the corpus", () => {
    const tampered = mutate(index, "APX-HR-POL-003@4.2", {
      relations: [{ kind: "supersedes", document_id: "APX-NOT-REAL", version: "1.0" }],
    });
    expect(() => check.check(records, tampered)).toThrow(/not in the corpus/);
  });

  it("refuses to promote an Unverified document above the lowest tier", () => {
    const tampered = mutate(index, "APX-ENG-KB-991@0.9", { tier: "policy" });
    expect(() => check.check(records, tampered)).toThrow(/must be "unverified"/);
  });

  it("refuses to let an unverified document act on another document", () => {
    const tampered = mutate(index, "APX-ENG-KB-991@0.9", {
      relations: [{ kind: "supersedes", document_id: "APX-PROC-POL-014", version: "3.0" }],
    });
    expect(() => check.check(records, tampered)).toThrow(/cannot supersede, amend or qualify/);
  });

  it("rejects an authority entry with no corpus record", () => {
    const tampered = new Map(index);
    tampered.set("GHOST-DOC@1.0", {
      ...index.get("APX-HR-POL-003@4.2")!,
      document_id: "GHOST-DOC",
      version: "1.0",
    });
    expect(() => check.check(records, tampered)).toThrow(/no matching corpus record/);
  });

  it("rejects a delegation quote absent from the delegating policy", () => {
    const tampered = mutate(index, "APX-PROC-MTX-006@1.2", {
      delegation_evidence: {
        document_id: "APX-PROC-POL-014",
        version: "3.0",
        quote: "Procurement may set any threshold it likes.",
      },
    });
    expect(() => check.checkDelegationQuotes(records, tampered)).toThrow(/delegation quote not found/);
  });
});
