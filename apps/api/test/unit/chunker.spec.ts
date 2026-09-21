import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chunkContent, chunkId, embeddingText } from "../../src/modules/corpus/chunker.js";

const PACK = resolve(import.meta.dirname, "../../../../Kentrick_Assessment_Pack_Candidate");

function corpus(): Record<string, string> {
  const raw = readFileSync(resolve(PACK, "normalized/corpus.jsonl"), "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as { document_id: string; version: string; content: string };
    out[`${rec.document_id}@${rec.version}`] = rec.content;
  }
  return out;
}

describe("chunker", () => {
  const docs = corpus();

  it("splits the current vendor policy on its six numbered headings plus a preamble", () => {
    const chunks = chunkContent(docs["APX-PROC-POL-014@3.0"]!);
    expect(chunks).toHaveLength(7);
    expect(chunks[0]!.sectionPath).toEqual(["Preamble"]);
    expect(chunks.map((c) => c.sectionPath[0])).toEqual([
      "Preamble",
      "1. Purpose",
      "2. Scope and definition",
      "3. Required approval process",
      "4. Evidence and records",
      "5. Exceptions",
      "6. Version control",
    ]);
  });

  it("rejects nested list items as headings in the retired policy", () => {
    // v2.1 section 3 contains its own "1." to "5." list. Only the four real
    // top-level headings, plus the preamble, should become chunks.
    const chunks = chunkContent(docs["APX-PROC-POL-014@2.1"]!);
    expect(chunks).toHaveLength(5);
    expect(chunks.map((c) => c.sectionPath[0])).toEqual([
      "Preamble",
      "1. Purpose",
      "2. Enterprise vendor threshold",
      "3. Former approval process",
      "4. Retirement notice",
    ]);
  });

  it("falls back to one chunk when a document has no numbered headings", () => {
    const chunks = chunkContent(docs["APX-PROC-MTX-006@1.2"]!);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.sectionPath).toEqual(["Document"]);
  });

  it("keeps char offsets exact so a citation resolves back to the source text", () => {
    const content = docs["APX-HR-POL-003@4.2"]!;
    for (const chunk of chunkContent(content)) {
      expect(content.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.text);
    }
  });

  it("covers the whole document with no gaps and no overlap", () => {
    const content = docs["APX-LEG-CON-NS-2026@1.0"]!;
    const chunks = chunkContent(content);
    expect(chunks[0]!.charStart).toBe(0);
    expect(chunks.at(-1)!.charEnd).toBe(content.length);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.charStart).toBe(chunks[i - 1]!.charEnd);
    }
  });

  it("reads Page markers into a page range", () => {
    const chunks = chunkContent(docs["APX-PROC-POL-014@2.1"]!);
    expect(chunks[0]!.pageStart).toBe(1);
  });

  it("builds a stable chunk id", () => {
    expect(chunkId("APX-PROC-POL-014", "3.0", 2)).toBe("APX-PROC-POL-014@3.0#2");
  });

  it("gives the embedder title and section context without changing the stored text", () => {
    const text = embeddingText(
      { title: "Employee Leave Policy", version: "4.2", sectionPath: ["1. Annual leave"] },
      "Employees request annual leave.",
    );
    expect(text).toBe(
      "Employee Leave Policy v4.2\n1. Annual leave\nEmployees request annual leave.",
    );
  });
});
