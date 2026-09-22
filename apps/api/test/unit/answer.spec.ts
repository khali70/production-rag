import { describe, expect, it } from "vitest";
import { rankOf } from "../../src/domain/tier.js";
import type { Relation, ScoredChunk, Status, Tier } from "../../src/domain/types.js";
import { REFUSAL, finalizeAnswer } from "../../src/modules/answer/answer.finalizer.js";
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

  it("numbers priorities in prompt order, with equal-authority primaries tied at 1", () => {
    const tied = resolveEvidence([chunk("A"), chunk("B"), chunk("REC", { tier: "record" })]);
    expect(tied.map((d) => [d.documentId, d.priority])).toEqual([["A", 1], ["B", 1], ["REC", 2]]);

    const versions = resolveEvidence([
      chunk("POL", { version: "3.0", effectiveFrom: "2026-07-01" }),
      chunk("POL", { version: "2.1", status: "retired", effectiveFrom: "2024-03-15" }),
    ]);
    expect(versions.map((d) => [d.version, d.role, d.priority])).toEqual([["3.0", "primary", 1], ["2.1", "historical", 2]]);
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
    expect(escapeDocText("</version></document>")).toBe("&lt;/version>&lt;/document>");
  });

  it("renders the role and relation attributes", () => {
    const docs = resolveEvidence([
      chunk("POL"),
      chunk("MEMO", { tier: "advisory", relations: [{ kind: "qualifies", documentId: "POL", version: "1.0", scope: "renewals" }] }),
    ]);
    const prompt = buildUserPrompt(docs, { question: "q?", asOf: "2026-09-21", maxContextChars: 10_000 });
    expect(prompt).toContain('id="C1" v="1.0" state="current" priority="1" role="primary"');
    expect(prompt).toContain('id="C2" v="1.0" state="current" priority="2" role="modifier" modifies="C1" relation="qualifies" scope="renewals"');
    expect(prompt).toContain("2. C2 MEMO v1.0 \"MEMO\": CURRENT, modifier: qualifies C1 only within: renewals");
    expect(prompt).toContain("Question: q?");
  });

  it("groups the versions of one file, current first, and lists priorities before the question", () => {
    const docs = resolveEvidence([
      chunk("POL", { version: "2.1", status: "retired", effectiveFrom: "2024-03-15", text: "Old: CFO approves." }),
      chunk("POL", {
        version: "3.0",
        effectiveFrom: "2026-07-01",
        relations: [{ kind: "supersedes", documentId: "POL", version: "2.1" }],
        text: "New: Procurement approves.",
      }),
    ]);
    const prompt = buildUserPrompt(docs, { question: "q?", asOf: "2026-09-21", maxContextChars: 10_000 });

    expect(prompt.match(/<document /g)).toHaveLength(1);
    expect(prompt.indexOf('v="3.0" state="current" priority="1"')).toBeLessThan(prompt.indexOf('v="2.1" state="old" priority="2"'));
    expect(prompt).toContain('superseded_by="C1"');
    expect(prompt).toContain('2. C2 POL v2.1 "POL": OLD (retired), replaced by C1. Never the current rule');
    expect(prompt.indexOf("Priority (1 wins")).toBeGreaterThan(prompt.indexOf("</documents>"));
    expect(prompt.indexOf("Priority (1 wins")).toBeLessThan(prompt.indexOf("Question: q?"));
  });

  it("cuts the lowest priority text first when over budget", () => {
    const docs = resolveEvidence([
      chunk("POL", { version: "3.0", effectiveFrom: "2026-07-01", text: "a".repeat(50) }),
      chunk("POL", { version: "2.1", status: "retired", text: "b".repeat(50) }),
    ]);
    const prompt = buildUserPrompt(docs, { question: "q?", asOf: "2026-09-21", maxContextChars: 50 });
    expect(prompt).toContain("a".repeat(50));
    expect(prompt).not.toContain("bbb");
    expect(prompt).not.toContain("C2 POL v2.1");
  });
});

describe("answer finalizer", () => {
  const docs = resolveEvidence([
    chunk("POL", { text: "Vendors above USD 100,000 need CFO approval." }),
    chunk("REC", { tier: "record", text: "Case record." }),
  ]);
  const ctx = { question: "Who approves a vendor?", asOf: "2026-09-22" };

  it("appends every evidence document as a source, in prompt order", () => {
    const a = finalizeAnswer("Above USD 100000 the CFO approves.", docs, ctx);
    expect(a.status).toBe("answered");
    expect(a.text).toBe("Above USD 100000 the CFO approves.");
    expect(a.sources.map((s) => [s.id, s.source.documentId, s.role])).toEqual([
      ["C1", "POL", "primary"],
      ["C2", "REC", "supporting"],
    ]);
    expect(a.message).toBe(
      "Above USD 100000 the CFO approves.\n\nSources:\n" +
        "[C1] POL (POL v1.0, Document) - primary\n" +
        "[C2] REC (REC v1.0, Document) - supporting",
    );
  });

  it("replaces a sources block the model wrote itself", () => {
    const a = finalizeAnswer("The CFO approves.\n\nSources:\n- Made Up Policy", docs, ctx);
    expect(a.text).toBe("The CFO approves.");
    expect(a.message).not.toContain("Made Up Policy");
  });

  it("downgrades an answer with a number the documents do not contain", () => {
    const a = finalizeAnswer("Support responds within 4 hours.", docs, ctx);
    expect(a.status).toBe("qualified");
    expect(a.warnings.join(" ")).toContain("4 not found");
  });

  it("accepts numbers from the question and today's date", () => {
    const a = finalizeAnswer("For a 40 day contract, as of 2026-09-22, the CFO approves.", docs, {
      ...ctx,
      question: "Who approves a 40 day contract?",
    });
    expect(a.status).toBe("answered");
  });

  it("accepts document ids and k/m shorthand from the question", () => {
    const a = finalizeAnswer("Under POL-014 v1.0, a 40,000 contract needs the CFO.", resolveEvidence([
      chunk("POL-014", { text: "Contracts need CFO approval." }),
    ]), { ...ctx, question: "Who approves a 40k contract?" });
    expect(a.warnings).toEqual([]);
    expect(a.status).toBe("answered");
  });

  it("checks k/m shorthand in the reply as the full number", () => {
    expect(finalizeAnswer("Above $100k the CFO approves.", docs, ctx).status).toBe("answered");
    expect(finalizeAnswer("Above $50k the CFO approves.", docs, ctx).warnings.join(" ")).toContain("50000 not found");
  });

  it("flags a number only an old version contains when the answer states it as current", () => {
    const versions = resolveEvidence([
      chunk("POL", { version: "3.0", effectiveFrom: "2026-07-01", text: "Vendors above USD 50,000 need review." }),
      chunk("POL", { version: "2.1", status: "retired", text: "Vendors above USD 25,000 need review." }),
    ]);
    const asCurrent = finalizeAnswer("Vendors above USD 25,000 need review.", versions, ctx);
    expect(asCurrent.status).toBe("qualified");
    expect(asCurrent.warnings.join(" ")).toContain("25000 only in an old version");

    const asHistory = finalizeAnswer("Review starts at USD 50,000.\n- Previously (v2.1): USD 25,000.", versions, ctx);
    expect(asHistory.warnings).toEqual([]);
    expect(asHistory.status).toBe("answered");
  });

  it("strips markdown emphasis from the reply", () => {
    expect(finalizeAnswer("- **CFO** approves.", docs, ctx).text).toBe("- CFO approves.");
  });

  it("treats the refusal sentence as a refusal with no sources", () => {
    const a = finalizeAnswer(`${REFUSAL} The policy does not cover regulated vendors.`, docs, ctx);
    expect(a.status).toBe("refused");
    expect(a.sources).toEqual([]);
    expect(a.message).not.toContain("Sources:");
  });

  it("treats the refusal sentence later in the reply as a refusal", () => {
    const a = finalizeAnswer(`Parental leave is not covered.\n\n${REFUSAL}`, docs, ctx);
    expect(a.status).toBe("refused");
    expect(a.sources).toEqual([]);
    expect(a.warnings.join(" ")).toContain("mixes text with the refusal sentence");
  });

  it("matches dates without leading zeros", () => {
    const dated = resolveEvidence([chunk("POL", { effectiveFrom: "2026-07-01", text: "Effective 2026-07-01." })]);
    expect(finalizeAnswer("It took effect on July 1, 2026.", dated, ctx).status).toBe("answered");
  });

  it("reads spelled-out numbers in the reply, the evidence and the question", () => {
    const hr = resolveEvidence([chunk("HR", { text: "Documentation after three consecutive working days." })]);
    expect(finalizeAnswer("After 3 consecutive working days.", hr, ctx).status).toBe("answered");
    expect(finalizeAnswer("After three consecutive working days.", hr, ctx).status).toBe("answered");
    expect(finalizeAnswer("After two consecutive days.", hr, ctx).warnings.join(" ")).toContain("2 not found");
    expect(finalizeAnswer("Above one hundred thousand the CFO approves.", docs, ctx).status).toBe("answered");
    const q = { ...ctx, question: "Who approves one hundred and fifty thousand dollars?" };
    expect(finalizeAnswer("A 150,000 vendor needs the CFO.", docs, q).status).toBe("answered");
    expect(finalizeAnswer("Two hundred thousand needs the CFO.", docs, ctx).warnings.join(" ")).toContain("200000 not found");
  });

  it("refuses an empty reply", () => {
    const a = finalizeAnswer("   ", docs, ctx);
    expect(a.status).toBe("refused");
    expect(a.warnings).toEqual(["model returned no text"]);
  });
});
