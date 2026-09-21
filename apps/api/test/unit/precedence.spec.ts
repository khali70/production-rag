import { describe, expect, it } from "vitest";
import { comparePrecedence, isOutrankedByLevel } from "../../src/domain/precedence.js";
import { rankOf } from "../../src/domain/tier.js";
import type { ScoredChunk, Tier } from "../../src/domain/types.js";

function chunk(
  id: string,
  opts: { tier: Tier; level: number; effectiveFrom?: string; score?: number },
): ScoredChunk {
  return {
    chunkId: id,
    text: id,
    score: opts.score ?? 0.5,
    cosine: 0.5,
    source: {
      documentId: id,
      version: "1.0",
      title: id,
      sourcePath: `corpus/${id}`,
      sectionPath: ["Document"],
      charStart: 0,
      charEnd: 1,
      chunkIndex: 0,
    },
    tier: opts.tier,
    authorityRank: rankOf(opts.tier),
    level: opts.level,
    classification: "INTERNAL",
    status: "current",
    trust: "normal",
    effectiveFrom: opts.effectiveFrom ?? "2026-01-01",
  };
}

const sorted = (chunks: ScoredChunk[]) => [...chunks].sort(comparePrecedence).map((c) => c.chunkId);

describe("precedence", () => {
  it("puts a higher management level first, even at the same tier", () => {
    const company = chunk("company", { tier: "policy", level: 0 });
    const team = chunk("team", { tier: "policy", level: 2 });
    expect(sorted([team, company])).toEqual(["company", "team"]);
  });

  it("lets level beat tier rank, so a department policy cannot override a company rule", () => {
    const companyAdvisory = chunk("company-advisory", { tier: "advisory", level: 0 });
    const deptPolicy = chunk("dept-policy", { tier: "policy", level: 1 });
    expect(sorted([deptPolicy, companyAdvisory])).toEqual(["company-advisory", "dept-policy"]);
  });

  it("keeps an unverified document last however high a level it claims", () => {
    const malicious = chunk("malicious", { tier: "unverified", level: 0 });
    const teamPolicy = chunk("team-policy", { tier: "policy", level: 2 });
    const record = chunk("record", { tier: "record", level: 2 });
    expect(sorted([malicious, record, teamPolicy])).toEqual(["team-policy", "record", "malicious"]);
  });

  it("falls back to tier rank at the same level", () => {
    const policy = chunk("policy", { tier: "policy", level: 1 });
    const standard = chunk("standard", { tier: "delegated_standard", level: 1 });
    const advisory = chunk("advisory", { tier: "advisory", level: 1 });
    expect(sorted([advisory, standard, policy])).toEqual(["policy", "standard", "advisory"]);
  });

  it("prefers the newer document when level and tier tie", () => {
    const older = chunk("older", { tier: "policy", level: 1, effectiveFrom: "2024-03-15" });
    const newer = chunk("newer", { tier: "policy", level: 1, effectiveFrom: "2026-07-01" });
    expect(sorted([older, newer])).toEqual(["newer", "older"]);
  });

  it("is a total order, so the same input always sorts the same way", () => {
    const a = chunk("a", { tier: "policy", level: 1 });
    const b = chunk("b", { tier: "policy", level: 1 });
    expect(sorted([a, b])).toEqual(sorted([b, a]));
  });

  it("reports when a candidate is outranked purely by level", () => {
    const high = chunk("high", { tier: "record", level: 0 });
    const low = chunk("low", { tier: "policy", level: 3 });
    expect(isOutrankedByLevel(low, high)).toBe(true);
    expect(isOutrankedByLevel(high, low)).toBe(false);
  });
});
