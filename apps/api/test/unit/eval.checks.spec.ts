import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../src/config/app-config.js";
import type { ScoredChunk } from "../../src/domain/types.js";
import type { AskResult } from "../../src/modules/answer/answer.service.js";
import type { Answer, Source } from "../../src/modules/answer/answer.types.js";
import type { EvidenceRole } from "../../src/modules/answer/evidence.resolver.js";
import { ExpectSchema, loadEvalFile, resultsPathFor } from "../../src/modules/eval/eval.cases.js";
import { checkGroups, checkRun, matchesRef, outcomeOf, touchesRestricted } from "../../src/modules/eval/eval.checks.js";

function chunk(documentId: string, version = "1.0", classification = "INTERNAL"): ScoredChunk {
  return {
    chunkId: `${documentId}@${version}#0`,
    text: "text",
    score: 0.5,
    cosine: 0.5,
    source: {
      documentId,
      version,
      title: documentId,
      sourcePath: `corpus/${documentId}`,
      sectionPath: [],
      charStart: 0,
      charEnd: 4,
      chunkIndex: 0,
    },
    tier: "policy",
    authorityRank: 100,
    level: 0,
    classification,
    status: "current",
    trust: "normal",
    effectiveFrom: "2026-01-01",
    owner: "owner",
    relations: [],
  };
}

const source = (documentId: string, version: string, role: EvidenceRole, i = 1): Source => ({
  id: `C${i}`,
  role,
  source: chunk(documentId, version).source,
});

function run(answer: Partial<Answer>, retrieved: ScoredChunk[] = []): AskResult {
  return {
    answer: { status: "answered", text: "", message: "", sources: [], warnings: [], ...answer },
    debug: {
      embedding: { dim: 0, preview: [], vector: [], ms: 0 },
      retrieved,
      searchMs: 0,
      bestCosine: 0.5,
      offTopic: [],
      related: { chunks: [], ms: 0 },
      versions: { chunks: [], ms: 0 },
      evidence: [],
      raw: [],
      generations: [],
      totalMs: 0,
    },
  };
}

const expectOf = (e: Record<string, unknown>) => ExpectSchema.parse({ status: ["answered"], ...e });

describe("matchesRef", () => {
  it("matches any version without @, one version with it", () => {
    expect(matchesRef("APX-1", { documentId: "APX-1", version: "2.1" })).toBe(true);
    expect(matchesRef("APX-1@3.0", { documentId: "APX-1", version: "2.1" })).toBe(false);
    expect(matchesRef("APX-1@3.0", { documentId: "APX-1", version: "3.0" })).toBe(true);
  });
});

describe("checkRun", () => {
  it("passes a current, cited, matching answer", () => {
    const r = run({ text: "USD 50,000 or more", message: "USD 50,000 or more", sources: [source("POL", "3.0", "primary")] });
    expect(checkRun(expectOf({ cite: [["POL@3.0"]], notCurrent: ["POL@2.1"], mustMatch: ["50,?000"] }), r)).toEqual([]);
  });

  it("fails a status outside the allowed list and says why", () => {
    const r = run({ status: "qualified", warnings: ["4 not found in the documents"] });
    expect(checkRun(expectOf({}), r)[0]).toContain("status qualified, expected answered (4 not found");
  });

  it("fails when a retired version is served as current, but not as historical", () => {
    const e = expectOf({ notCurrent: ["POL@2.1"] });
    expect(checkRun(e, run({ sources: [source("POL", "2.1", "primary")] }))).toHaveLength(1);
    expect(checkRun(e, run({ sources: [source("POL", "3.0", "primary"), source("POL", "2.1", "historical", 2)] }))).toEqual([]);
  });

  it("accepts any member of a cite group, but not a historical one", () => {
    const e = expectOf({ cite: [["POL@3.0", "MTX"]] });
    expect(checkRun(e, run({ sources: [source("MTX", "1.2", "modifier")] }))).toEqual([]);
    expect(checkRun(e, run({ sources: [source("POL", "3.0", "historical")] }))).toHaveLength(1);
  });

  it("skips cite and mustMatch on a refusal", () => {
    const e = ExpectSchema.parse({ status: ["refused"], cite: [["POL"]], mustMatch: ["50"] });
    expect(checkRun(e, run({ status: "refused", text: "no", message: "no" }))).toEqual([]);
  });

  it("flags a restricted document that was only retrieved, never shown", () => {
    const r = run({ status: "refused" }, [chunk("CASE-778")]);
    const failures = checkRun(ExpectSchema.parse({ status: ["refused"], neverRetrieved: ["CASE-778"] }), r);
    expect(failures).toEqual(["LEAK: CASE-778 v1.0 entered the pipeline for this user"]);
  });

  it("checks forbidden patterns in the message and the warnings, whatever the status", () => {
    const e = ExpectSchema.parse({ status: ["refused"], mustNotMatch: ["\\b\\d+\\s*hours?\\b"] });
    expect(checkRun(e, run({ status: "refused", message: "respond within 4 hours" }))).toHaveLength(1);
    expect(checkRun(e, run({ status: "refused", message: "during business hours" }))).toEqual([]);
  });

  it("fails when a forbidden document is the first source", () => {
    const e = expectOf({ notFirst: ["KB-991"] });
    expect(checkRun(e, run({ sources: [source("KB-991", "0.9", "supporting")] }))).toHaveLength(1);
    expect(checkRun(e, run({ sources: [source("POL", "3.0", "primary"), source("KB-991", "0.9", "supporting", 2)] }))).toEqual([]);
  });
});

describe("outcomes and groups", () => {
  it("fails every member of a group whose outcomes disagree", () => {
    const a = run({ sources: [source("POL", "3.0", "primary")] });
    const b = run({ status: "refused" });
    expect(outcomeOf(a)).toBe("answered from POL");
    expect(outcomeOf(b)).toBe("refused");
    const cases = [
      { case: { id: "a", group: "g" }, outcomes: [outcomeOf(a)] },
      { case: { id: "b", group: "g" }, outcomes: [outcomeOf(b)] },
      { case: { id: "c", group: "h" }, outcomes: [outcomeOf(a)] },
    ] as Parameters<typeof checkGroups>[0];
    const failures = checkGroups(cases);
    expect([...failures.keys()]).toEqual(["a", "b"]);
  });

  it("detects restricted evidence so its text stays out of results files", () => {
    const r = run({});
    r.debug.evidence = [{ chunks: [chunk("CASE-778", "1.0", "RESTRICTED_HR_INVESTIGATION")] } as AskResult["debug"]["evidence"][number]];
    expect(touchesRestricted(r)).toBe(true);
  });
});

describe("cases file", () => {
  it("the committed cases file is valid", async () => {
    const file = await loadEvalFile(resolve(REPO_ROOT, "eval/cases.v1.json"));
    expect(file.cases.length).toBeGreaterThan(0);
    for (const incident of ["wrong-policy", "unsupported", "leak"]) {
      expect(file.cases.some((c) => c.incident === incident && c.demo)).toBe(true);
    }
  });

  it("writes results next to the cases", () => {
    expect(resultsPathFor("/r/eval/cases.v1.json", "llm")).toBe("/r/eval/results.v1.llm.json");
    expect(resultsPathFor("/r/eval/my.json", "llm")).toBe("/r/eval/my.results.llm.json");
  });
});
