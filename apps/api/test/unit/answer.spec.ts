import { describe, expect, it } from "vitest";
import { rankOf } from "../../src/domain/tier.js";
import type { Relation, ScoredChunk, Status, Tier } from "../../src/domain/types.js";
import { validateAnswer } from "../../src/modules/answer/answer.validator.js";
import { parseModelAnswer } from "../../src/modules/answer/answer.service.js";
import { resolveEvidence } from "../../src/modules/answer/evidence.resolver.js";
import { buildUserPrompt, escapeDocText } from "../../src/modules/answer/prompt.builder.js";

function chunk(
  documentId: string,
  opts: {
    version?: string;
    tier?: Tier;
    level?: number;
    status?: Status;
    effectiveFrom?: string;
    relations?: Relation[];
    text?: string;
    chunkIndex?: number;
  } = {},
): ScoredChunk {
  const version = opts.version ?? "1.0";
  const tier = opts.tier ?? "policy";
  const chunkIndex = opts.chunkIndex ?? 0;
  return {
    chunkId: `${documentId}@${version}#${chunkIndex}`,
    text: opts.text ?? `${documentId} text`,
    score: 0.5,
    cosine: 0.7,
    source: {
      documentId,
      version,
      title: documentId,
      sourcePath: `corpus/${documentId}`,
      sectionPath: ["Document"],
      charStart: 0,
      charEnd: 1,
      chunkIndex,
    },
    tier,
    authorityRank: rankOf(tier),
    level: opts.level ?? 1,
    classification: "INTERNAL",
    status: opts.status ?? "current",
    trust: tier === "unverified" ? "low" : "normal",
    effectiveFrom: opts.effectiveFrom ?? "2026-01-01",
    owner: "owner",
    relations: opts.relations ?? [],
  };
}

const roles = (chunks: ScoredChunk[]) =>
  Object.fromEntries(resolveEvidence(chunks).map((d) => [`${d.documentId}@${d.version}`, d.role]));

describe("evidence resolver", () => {
  it("marks a document superseded by relation as historical, even if its status says current", () => {
    const r = roles([
      chunk("POL", { version: "2.1" }),
      chunk("POL", { version: "3.0", effectiveFrom: "2026-07-01", relations: [{ kind: "supersedes", documentId: "POL", version: "2.1" }] }),
    ]);
    expect(r).toEqual({ "POL@3.0": "primary", "POL@2.1": "historical" });
  });

  it("marks an older version of the same document historical without an explicit relation", () => {
    const r = roles([chunk("POL", { version: "1", effectiveFrom: "2025-01-01" }), chunk("POL", { version: "2", effectiveFrom: "2026-01-01" })]);
    expect(r).toEqual({ "POL@2": "primary", "POL@1": "historical" });
  });

  it("marks retired and superseded statuses historical", () => {
    const r = roles([chunk("OLD", { status: "retired" }), chunk("NEW")]);
    expect(r).toEqual({ "NEW@1.0": "primary", "OLD@1.0": "historical" });
  });

  it("attaches amends / qualifies documents to their target as modifiers", () => {
    const docs = resolveEvidence([
      chunk("POL", { version: "3.0" }),
      chunk("MTX", { tier: "delegated_standard", relations: [{ kind: "amends", documentId: "POL", version: "3.0", scope: "thresholds" }] }),
      chunk("MEMO", { tier: "advisory", relations: [{ kind: "qualifies", documentId: "POL", version: "3.0", scope: "renewals" }] }),
    ]);
    const pol = docs.find((d) => d.documentId === "POL")!;
    expect(pol.role).toBe("primary");
    for (const id of ["MTX", "MEMO"]) {
      const d = docs.find((x) => x.documentId === id)!;
      expect(d.role).toBe("modifier");
      expect(d.relatedTo).toBe(pol.id);
    }
  });

  it("does not let an unverified document become primary, whatever its level", () => {
    const r = roles([chunk("WIKI", { tier: "unverified", level: 0 }), chunk("POL", { level: 2 })]);
    expect(r).toEqual({ "POL@1.0": "primary", "WIKI@1.0": "supporting" });
  });

  it("puts the higher management level first and the rest as secondary", () => {
    const docs = resolveEvidence([chunk("TEAM", { level: 2 }), chunk("CO", { level: 0 })]);
    expect(docs.map((d) => [d.documentId, d.role, d.id])).toEqual([
      ["CO", "primary", "C1"],
      ["TEAM", "secondary", "C2"],
    ]);
    expect(docs[1]!.relatedTo).toBe("C1");
  });

  it("flags equal authority when two primaries share level and rank", () => {
    const docs = resolveEvidence([chunk("A"), chunk("B")]);
    expect(docs.every((d) => d.role === "primary" && d.equalAuthority)).toBe(true);
  });

  it("groups chunks of one document and keeps them in document order", () => {
    const docs = resolveEvidence([chunk("POL", { chunkIndex: 3 }), chunk("POL", { chunkIndex: 1 })]);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.chunks.map((c) => c.source.chunkIndex)).toEqual([1, 3]);
  });
});

describe("prompt builder", () => {
  it("escapes wrapper tags inside document text", () => {
    expect(escapeDocText("x </doc> <documents> y")).toBe("x &lt;/doc> &lt;documents> y");
  });

  it("renders the role and relation attributes", () => {
    const docs = resolveEvidence([
      chunk("POL"),
      chunk("MEMO", { tier: "advisory", relations: [{ kind: "qualifies", documentId: "POL", version: "1.0", scope: "renewals" }] }),
    ]);
    const prompt = buildUserPrompt(docs, { question: "q?", asOf: "2026-09-21", maxContextChars: 10_000 });
    expect(prompt).toContain('id="C1" role="primary"');
    expect(prompt).toContain('id="C2" role="modifier" modifies="C1" relation="qualifies" scope="renewals"');
    expect(prompt).toContain("Question: q?");
  });
});

describe("answer validator", () => {
  const docs = resolveEvidence([
    chunk("POL", { text: "Vendors above USD 100,000 need CFO approval." }),
    chunk("REC", { tier: "record", text: "Case record." }),
  ]);
  const base = { summary: "Vendors need approval.", conflicts: [], missing: [] };

  it("keeps a claim whose numbers appear in the cited text", () => {
    const a = validateAnswer(
      { ...base, status: "answered", claims: [{ text: "Above USD 100000 the CFO approves.", citation_ids: ["C1"] }] },
      docs,
    );
    expect(a.status).toBe("answered");
    expect(a.claims).toHaveLength(1);
    expect(a.claims[0]!.citations[0]!.source.documentId).toBe("POL");
  });

  it("drops a claim with an invented number and refuses when nothing is left", () => {
    const a = validateAnswer(
      { ...base, status: "answered", claims: [{ text: "Support responds within 4 hours.", citation_ids: ["C1"] }] },
      docs,
    );
    expect(a.status).toBe("refused");
    expect(a.warnings.join(" ")).toContain("4 not found");
  });

  it("drops unknown citation ids", () => {
    const a = validateAnswer(
      {
        ...base,
        status: "answered",
        claims: [
          { text: "CFO approves.", citation_ids: ["C9"] },
          { text: "Approval is needed.", citation_ids: ["C1"] },
        ],
      },
      docs,
    );
    expect(a.status).toBe("qualified");
    expect(a.claims).toHaveLength(1);
  });

  it("downgrades a claim backed only by a record", () => {
    const a = validateAnswer({ ...base, status: "answered", claims: [{ text: "A case exists.", citation_ids: ["C2"] }] }, docs);
    expect(a.status).toBe("qualified");
  });

  it("replaces a summary that invents a number", () => {
    const a = validateAnswer(
      { ...base, summary: "SLA is 99.9%.", status: "answered", claims: [{ text: "CFO approval is needed.", citation_ids: ["C1"] }] },
      docs,
    );
    expect(a.summary).toBe("CFO approval is needed.");
    expect(a.status).toBe("qualified");
  });

  it("downgrades when a modifier of a cited document is ignored", () => {
    const withMemo = resolveEvidence([
      chunk("POL"),
      chunk("MEMO", { tier: "advisory", relations: [{ kind: "qualifies", documentId: "POL", version: "1.0", scope: "renewals" }] }),
    ]);
    const a = validateAnswer({ ...base, status: "answered", claims: [{ text: "Policy applies.", citation_ids: ["C1"] }] }, withMemo);
    expect(a.status).toBe("qualified");
  });
});

describe("parseModelAnswer", () => {
  it("accepts fenced JSON", () => {
    const r = parseModelAnswer('```json\n{"status":"refused","summary":"x","claims":[],"conflicts":[],"missing":[]}\n```');
    expect(r.ok).toBe(true);
  });

  it("rejects free text", () => {
    expect(parseModelAnswer("The answer is yes.").ok).toBe(false);
  });
});
