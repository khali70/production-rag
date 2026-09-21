/**
 * Ingest-time scan for instruction-like content.
 *
 * A document is data, never an instruction. A hit does not block ingest: it
 * marks the document `trust: low` and caps its tier at `unverified`, so it can
 * never define a rule, never supersede anything, and never reaches the model
 * as an instruction.
 *
 * This is defense in depth, not the primary control. Permissions are decided
 * before retrieval runs, so even a model that swallows an injected instruction
 * cannot widen what it was allowed to see.
 */
const PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = Object.freeze([
  { id: "ignore-instructions", re: /\bignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\b/i },
  { id: "disregard-rules", re: /\bdisregard\s+(all\s+|any\s+|the\s+)?(previous|prior|rules|instructions|restrictions)\b/i },
  { id: "override-rules", re: /\b(override|bypass|circumvent)\s+(the\s+)?(rules|policy|policies|restrictions|permissions|guardrails)\b/i },
  { id: "reveal-secrets", re: /\b(reveal|disclose|expose|print|output|list)\b[^.\n]{0,60}\b(secret|secrets|api key|api keys|credential|credentials|password|token)\b/i },
  { id: "reveal-system-prompt", re: /\bsystem prompt\b/i },
  { id: "claim-authority", re: /\btreat (this|the following)\b[^.\n]{0,40}\b(as|with)\b[^.\n]{0,40}\b(higher|highest|top) (priority|authority)\b/i },
  { id: "act-as", re: /\byou are now\b|\bact as (an?|the)\b[^.\n]{0,30}\b(admin|administrator|developer|system)\b/i },
  { id: "exfiltrate", re: /\b(send|post|upload|forward)\b[^.\n]{0,40}\b(to|at)\b[^.\n]{0,20}(https?:\/\/|@)/i },
]);

export type InjectionFinding = {
  patternId: string;
  /** Offset into the scanned content, so the finding can be shown in context. */
  index: number;
  excerpt: string;
};

export function scanForInjection(content: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const { id, re } of PATTERNS) {
    const match = re.exec(content);
    if (!match) continue;
    findings.push({
      patternId: id,
      index: match.index,
      excerpt: content.slice(match.index, match.index + 120).replace(/\s+/g, " ").trim(),
    });
  }
  return findings;
}
