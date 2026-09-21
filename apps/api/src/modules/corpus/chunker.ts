import type { SourceRef } from "../../domain/types.js";

/**
 * Splits a document's `content` on its numbered top-level headings.
 *
 * A heading is a line like "3. Required approval process": short, no trailing
 * period, and numbered with the next expected integer. That last condition is
 * what separates a real section heading from a nested list item, which the
 * retired policy v2.1 is full of ("1. Business owner submitted...").
 *
 * Offsets point into the original `content` string, so a citation resolves back
 * to the exact span the claim came from.
 */
const MAX_HEADING_LENGTH = 80;

export type Chunk = {
  chunkIndex: number;
  sectionPath: string[];
  text: string;
  charStart: number;
  charEnd: number;
  pageStart?: number;
  pageEnd?: number;
};

type Heading = { number: number; title: string; lineStart: number; lineEnd: number };

function findHeadings(content: string): Heading[] {
  const headings: Heading[] = [];
  let expected = 1;
  let offset = 0;

  for (const line of content.split("\n")) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1; // +1 for the newline consumed by split

    const match = /^(\d+)\.\s+(\S.*)$/.exec(line);
    if (!match) continue;

    const number = Number(match[1]);
    const title = match[2]!.trim();
    if (number !== expected) continue;
    if (line.length > MAX_HEADING_LENGTH) continue;
    // A sentence, not a heading.
    if (title.endsWith(".")) continue;

    headings.push({ number, title: line.trim(), lineStart, lineEnd });
    expected += 1;
  }

  return headings;
}

/** "Page 4" markers, when the supplied text carries them. */
function pageRange(text: string): { pageStart?: number; pageEnd?: number } {
  const pages = [...text.matchAll(/\bPage\s+(\d+)\b/gi)].map((m) => Number(m[1]));
  if (pages.length === 0) return {};
  return { pageStart: Math.min(...pages), pageEnd: Math.max(...pages) };
}

export function chunkContent(content: string): Chunk[] {
  const headings = findHeadings(content);

  // No usable headings: the whole document is one chunk. The pack's documents
  // are short enough that this stays well inside the model's 512-token window.
  if (headings.length === 0) {
    return [
      {
        chunkIndex: 0,
        sectionPath: ["Document"],
        text: content,
        charStart: 0,
        charEnd: content.length,
        ...pageRange(content),
      },
    ];
  }

  const chunks: Chunk[] = [];

  // Everything before the first heading (title block, classification line).
  const firstStart = headings[0]!.lineStart;
  if (firstStart > 0) {
    const text = content.slice(0, firstStart);
    if (text.trim().length > 0) {
      chunks.push({
        chunkIndex: 0,
        sectionPath: ["Preamble"],
        text,
        charStart: 0,
        charEnd: firstStart,
        ...pageRange(text),
      });
    }
  }

  headings.forEach((heading, i) => {
    const charStart = heading.lineStart;
    const charEnd = i + 1 < headings.length ? headings[i + 1]!.lineStart : content.length;
    const text = content.slice(charStart, charEnd);
    chunks.push({
      chunkIndex: chunks.length,
      sectionPath: [heading.title],
      text,
      charStart,
      charEnd,
      ...pageRange(text),
    });
  });

  return chunks;
}

/** chunk_id is stable across re-ingest, so upserts update in place. */
export function chunkId(documentId: string, version: string, chunkIndex: number): string {
  return `${documentId}@${version}#${chunkIndex}`;
}

/**
 * Text handed to the embedding model. Title and section give a short chunk the
 * context it needs; the stored `text` stays the raw slice so offsets hold.
 */
export function embeddingText(source: Pick<SourceRef, "title" | "version" | "sectionPath">, text: string): string {
  return `${source.title} v${source.version}\n${source.sectionPath.join(" > ")}\n${text}`;
}
