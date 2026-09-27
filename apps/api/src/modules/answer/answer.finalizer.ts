import type { ScoredChunk } from "../../domain/types.js";
import type { Answer, Match, Source } from "./answer.types.js";
import type { EvidenceDoc } from "./evidence.resolver.js";

/** The exact sentence the prompt tells the model to use when the documents do not answer. */
export const REFUSAL = "I could not find the answer in the documents you have access to.";

/** Digits with thousands separators or decimals: 100,000 / 2.5 / 2026-07-01 -> 2026, 07, 01. */
const NUMBER = /\d+(?:[.,]\d+)*/g;

/**
 * Canonical form: "100,000" and "100000" compare equal, the trailing sentence
 * dot is dropped, and leading zeros go, so "2026-07-01" and "July 1" share the 1.
 */
function normalizeNumber(n: string): string {
  const plain = n.replace(/,(?=\d{3}\b)/g, "").replace(/\.$/, "");
  return /^\d+$/.test(plain) ? String(Number(plain)) : plain;
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9 };
const NUMBER_WORD = `(?:${[...Object.keys(UNITS), "hundred", ...Object.keys(SCALES)].join("|")})`;
const WORD_RUN = new RegExp(`\\b${NUMBER_WORD}(?:[\\s-]+(?:and[\\s-]+)?${NUMBER_WORD})*\\b`, "gi");

/** "one hundred and fifty thousand" -> 150000, "five" -> 5, "hundred-thousand" -> 100000. */
function wordsToDigits(text: string): string {
  return text.replace(WORD_RUN, (run) => {
    let total = 0;
    let current = 0;
    for (const w of run.toLowerCase().split(/[\s-]+/)) {
      if (w === "and") continue;
      if (w === "hundred") current = (current || 1) * 100;
      else if (w in SCALES) {
        total += (current || 1) * SCALES[w]!;
        current = 0;
      } else current += UNITS[w]!;
    }
    return String(total + current);
  });
}

function numbersIn(text: string): string[] {
  // Evidence ids like C3 are not facts.
  const cleaned = wordsToDigits(text).replace(/\bC\d+\b/g, " ");
  return (cleaned.match(NUMBER) ?? []).map(normalizeNumber);
}

const SHORTHAND = /(\d+(?:\.\d+)?)\s*([km])\b/gi;

const fullNumber = (n: string, unit: string) => String(Math.round(Number(n) * (unit.toLowerCase() === "k" ? 1e3 : 1e6)));

/** "40k" / "2.5m" in a question also allow 40000 / 2500000 in the answer. */
function expandShorthand(text: string): string {
  return text.replace(SHORTHAND, (m, n: string, unit: string) => `${m} ${fullNumber(n, unit)}`);
}

/** "$50k" in the reply is checked as 50000, not as 50. */
function resolveShorthand(text: string): string {
  return text.replace(SHORTHAND, (_m, n: string, unit: string) => fullNumber(n, unit));
}

/** Small models add markdown emphasis despite the prompt; the answer is plain text. */
const stripEmphasis = (text: string) => text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1");

/** A sentence that presents its content as history, so an old version's numbers may appear in it. */
const MARKED_OLD = /\b(previous(ly)?|former(ly)?|old|older|earlier|retired|superseded|replaced|no longer|used to)\b/i;

/** A trailing "Sources:" / "References:" block the model added despite the prompt. Ours replaces it. */
const MODEL_SOURCES = /\n\s*(?:\*\*)?(?:sources|references)(?:\*\*)?\s*:[\s\S]*$/i;

function formatSources(sources: Source[]): string {
  const lines = sources.map(({ id, role, source: s }) => {
    const section = s.sectionPath.length > 0 ? `, ${s.sectionPath.join(" > ")}` : "";
    return `[${id}] ${s.title} (${s.documentId} v${s.version}${section}) - ${role}`;
  });
  return `Sources:\n${lines.join("\n")}`;
}

export type FinalizeContext = {
  question: string;
  asOf: string;
};

/**
 * Turns the model's plain-text reply into the final answer: detects a refusal,
 * appends the sources the model was given, and flags any number the evidence
 * does not contain (Incident 2: an invented SLA) or that only an old version
 * contains but the answer states as current (Incident 1: the retired policy).
 * Without structured claims a flagged number cannot be cut out, so the answer
 * is downgraded instead.
 */
export function finalizeAnswer(reply: string, docs: EvidenceDoc[], ctx: FinalizeContext): Answer {
  const text = stripEmphasis(reply.replace(MODEL_SOURCES, "")).trim();
  const warnings: string[] = [];

  if (text.length === 0) {
    return { status: "refused", text: REFUSAL, message: REFUSAL, sources: [], warnings: ["model returned no text"] };
  }
  // The refusal sentence anywhere means the documents did not answer, even
  // when the model wrote other text around it first.
  const refusalAt = text.toLowerCase().indexOf(REFUSAL.slice(0, 30).toLowerCase());
  if (refusalAt >= 0) {
    const mixed = refusalAt > 0 ? ["reply mixes text with the refusal sentence: treated as refused"] : [];
    return { status: "refused", text, message: text, sources: [], warnings: mixed };
  }

  // Numbers may come from the evidence text, its metadata (ids, versions,
  // dates), the question itself, or today's date. A number only an old version
  // contains is allowed only in a sentence that says it is old.
  const current = docs.filter((d) => d.role !== "historical");
  const old = docs.filter((d) => d.role === "historical");
  const available = new Set(
    numbersIn(
      [
        ...docs.flatMap((d) => [d.documentId, d.version, d.title, d.effectiveFrom]),
        ...current.flatMap((d) => d.chunks.map((c) => c.text)),
        expandShorthand(ctx.question),
        ctx.asOf,
      ].join("\n"),
    ),
  );
  const oldOnly = new Set(numbersIn(old.flatMap((d) => d.chunks.map((c) => c.text)).join("\n")));

  const invented = new Set<string>();
  const oldAsCurrent = new Set<string>();
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    for (const n of numbersIn(resolveShorthand(sentence))) {
      if (available.has(n)) continue;
      if (!oldOnly.has(n)) invented.add(n);
      else if (!MARKED_OLD.test(sentence)) oldAsCurrent.add(n);
    }
  }
  if (invented.size > 0) warnings.push(`${[...invented].join(", ")} not found in the documents: verify before relying on it`);
  if (oldAsCurrent.size > 0) {
    warnings.push(`${[...oldAsCurrent].join(", ")} only in an old version, stated as if current: it is not the rule in force`);
  }

  const sources: Source[] = docs.map((d) => ({ id: d.id, role: d.role, source: d.chunks[0]!.source }));
  return {
    status: warnings.length > 0 ? "qualified" : "answered",
    text,
    message: `${text}\n\n${formatSources(sources)}`,
    sources,
    warnings,
  };
}

/** A question about how things used to be: an old version may be the right answer. */
const ASKS_HISTORY = /\b(old|older|previous(ly)?|before|former(ly)?|replace[ds]?|used to|earlier|retired|superseded|history|originally)\b/i;

/**
 * retrieval mode: picks the answer from the reranked chunks, best first. The
 * reranker scores wording, not validity, and a retired version often words the
 * same rule more plainly than its replacement. So the first chunk from a
 * current version wins, unless the question asks about the past.
 */
export function pickBestMatch(chunks: ScoredChunk[], question: string): { chunk: ScoredChunk; reason: string } {
  const top = chunks[0]!;
  if (top.status === "current") return { chunk: top, reason: "highest reranked chunk, current version" };
  if (ASKS_HISTORY.test(question)) return { chunk: top, reason: `highest reranked chunk; ${top.status} version kept because the question asks about the past` };
  const current = chunks.find((c) => c.status === "current");
  if (!current) return { chunk: top, reason: `highest reranked chunk; no current version among the top ${chunks.length}` };
  return {
    chunk: current,
    reason: `rank ${chunks.indexOf(current) + 1}: the first current version, preferred over higher-ranked ${top.status} ${top.source.documentId} v${top.source.version}`,
  };
}

/** A current document that amends the picked one's document, with the scope of the change. */
export type Amendment = { chunk: ScoredChunk; scope: string };

/**
 * retrieval mode: related chunks that amend the picked chunk's document, any
 * version of it. The reranker reads a table such as an approval matrix as
 * loose words and scores it low, so the policy wins the pick while its numbers
 * live in the matrix. Following the reviewed relation brings the matrix along.
 * Qualifications are left out: they narrow one stage and would be noise on
 * most answers.
 */
export function amendmentsOf(picked: ScoredChunk, related: ScoredChunk[]): Amendment[] {
  const out: Amendment[] = [];
  for (const c of related) {
    if (c.status !== "current" || c.source.documentId === picked.source.documentId) continue;
    const rel = c.relations.find((r) => r.kind === "amends" && r.documentId === picked.source.documentId);
    if (rel && rel.kind === "amends") out.push({ chunk: c, scope: rel.scope });
  }
  return out;
}

const toMatch = (chunk: ScoredChunk, docs: EvidenceDoc[], rerankScores: Record<string, number>): Match => ({
  chunkId: chunk.chunkId,
  source: chunk.source,
  status: chunk.status,
  effectiveFrom: chunk.effectiveFrom,
  role: docs.find((d) => d.documentId === chunk.source.documentId && d.version === chunk.source.version)?.role ?? "primary",
  rerankScore: rerankScores[chunk.chunkId] ?? null,
  cosine: chunk.cosine,
});

/**
 * retrieval mode: the best chunk is the answer, verbatim, followed by the
 * chunks of any current document that amends it. Nothing is generated, so
 * there is nothing to number-check; the answer is only downgraded when the
 * chunk is not the rule in force or its document is low trust. A contract or
 * case record is a fine answer to a question about it.
 */
export function bestMatchAnswer(
  chunk: ScoredChunk,
  evidence: EvidenceDoc[],
  rerankScores: Record<string, number>,
  amendments: Amendment[] = [],
): Answer {
  const parts = [chunk.text.trim()];
  for (const { chunk: a, scope } of amendments) {
    parts.push(`Amended by ${a.source.documentId} v${a.source.version} "${a.source.title}" (${scope}):\n${a.text.trim()}`);
  }
  const text = parts.join("\n\n");
  const warnings: string[] = [];
  if (chunk.status !== "current") warnings.push(`best match is from a ${chunk.status} version: not the rule in force`);
  if (chunk.trust === "low") warnings.push("best match is from a low-trust document: verify before relying on it");

  const match = toMatch(chunk, evidence, rerankScores);
  const amended = amendments.map(({ chunk: a, scope }) => ({ ...toMatch(a, evidence, rerankScores), scope }));
  const sources: Source[] = [
    { id: "C1", role: match.role, source: chunk.source },
    ...amended.map((m, i) => ({ id: `C${i + 2}`, role: m.role, source: m.source })),
  ];
  return {
    status: warnings.length > 0 ? "qualified" : "answered",
    text,
    message: `${text}\n\n${formatSources(sources)}`,
    sources,
    warnings,
    match,
    ...(amended.length > 0 ? { amendments: amended } : {}),
  };
}
