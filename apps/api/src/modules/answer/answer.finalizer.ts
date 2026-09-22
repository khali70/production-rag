import type { Answer, Source } from "./answer.types.js";
import type { EvidenceDoc } from "./evidence.resolver.js";

/** The exact sentence the prompt tells the model to use when the documents do not answer. */
export const REFUSAL = "I could not find the answer in the documents you have access to.";

/** Digits with thousands separators or decimals: 100,000 / 2.5 / 2026-07-01 -> 2026, 07, 01. */
const NUMBER = /\d+(?:[.,]\d+)*/g;

/** Canonical form: "100,000" and "100000" compare equal; trailing sentence dot dropped. */
function normalizeNumber(n: string): string {
  return n.replace(/,(?=\d{3}\b)/g, "").replace(/\.$/, "");
}

function numbersIn(text: string): string[] {
  // Evidence ids like C3 are not facts.
  const cleaned = text.replace(/\bC\d+\b/g, " ");
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
 * does not contain (Incident 2: an invented SLA). Without structured claims a
 * flagged number cannot be cut out, so the answer is downgraded instead.
 */
export function finalizeAnswer(reply: string, docs: EvidenceDoc[], ctx: FinalizeContext): Answer {
  const text = stripEmphasis(reply.replace(MODEL_SOURCES, "")).trim();
  const warnings: string[] = [];

  if (text.length === 0) {
    return { status: "refused", text: REFUSAL, message: REFUSAL, sources: [], warnings: ["model returned no text"] };
  }
  if (text.toLowerCase().startsWith(REFUSAL.slice(0, 30).toLowerCase())) {
    return { status: "refused", text, message: text, sources: [], warnings: [] };
  }

  // Numbers may come from the evidence text, its metadata (ids, versions,
  // dates), the question itself, or today's date.
  const allowed = [
    ...docs.flatMap((d) => [d.documentId, d.version, d.title, d.effectiveFrom, ...d.chunks.map((c) => c.text)]),
    expandShorthand(ctx.question),
    ctx.asOf,
  ];
  const available = new Set(numbersIn(allowed.join("\n")));
  const invented = [...new Set(numbersIn(resolveShorthand(text)).filter((n) => !available.has(n)))];
  if (invented.length > 0) warnings.push(`${invented.join(", ")} not found in the documents: verify before relying on it`);

  const sources: Source[] = docs.map((d) => ({ id: d.id, role: d.role, source: d.chunks[0]!.source }));
  return {
    status: warnings.length > 0 ? "qualified" : "answered",
    text,
    message: `${text}\n\n${formatSources(sources)}`,
    sources,
    warnings,
  };
}
