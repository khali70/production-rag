import type { Answer, Citation, ModelAnswer } from "./answer.schema.js";
import type { EvidenceDoc, EvidenceRole } from "./evidence.resolver.js";

/** Roles that may carry a claim on their own. */
const GROUNDING_ROLES: ReadonlySet<EvidenceRole> = new Set(["primary", "modifier", "secondary"]);

/** Digits with thousands separators or decimals: 100,000 / 2.5 / 2026-07-01 -> 2026, 07, 01. */
const NUMBER = /\d+(?:[.,]\d+)*/g;

/** Canonical form: "100,000" and "100000" compare equal; trailing sentence dot dropped. */
function normalizeNumber(n: string): string {
  return n.replace(/,(?=\d{3}\b)/g, "").replace(/\.$/, "");
}

function numbersIn(text: string): string[] {
  // Citation ids like C3 are not facts.
  const cleaned = text.replace(/\bC\d+\b/g, " ");
  return (cleaned.match(NUMBER) ?? []).map(normalizeNumber);
}

/**
 * Checks the model output against the evidence it was given. Anything the
 * evidence does not support is dropped and the answer is downgraded, never
 * silently kept (Incident 2: an invented SLA).
 */
export function validateAnswer(model: ModelAnswer, docs: EvidenceDoc[]): Answer {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const warnings: string[] = [];
  let status = model.status;
  const downgrade = (reason: string) => {
    warnings.push(reason);
    if (status === "answered") status = "qualified";
  };

  const toCitations = (ids: string[], where: string): Citation[] => {
    const out: Citation[] = [];
    for (const id of new Set(ids)) {
      const doc = byId.get(id);
      if (!doc) {
        downgrade(`${where}: cited unknown id ${id}, removed`);
        continue;
      }
      const first = doc.chunks[0]!;
      out.push({ id, role: doc.role, source: first.source });
    }
    return out;
  };

  const claims: Answer["claims"] = [];
  for (const [i, claim] of model.claims.entries()) {
    const where = `claim ${i + 1}`;
    const citations = toCitations(claim.citation_ids, where);
    if (citations.length === 0) {
      downgrade(`${where}: no valid citation, dropped`);
      continue;
    }

    const citedText = citations
      .flatMap((c) => byId.get(c.id)!.chunks.map((ch) => ch.text))
      .join("\n");
    const available = new Set(numbersIn(citedText));
    const invented = numbersIn(claim.text).filter((n) => !available.has(n));
    if (invented.length > 0) {
      downgrade(`${where}: ${invented.join(", ")} not found in cited text, dropped`);
      continue;
    }

    if (!citations.some((c) => GROUNDING_ROLES.has(c.role))) {
      downgrade(`${where}: backed only by supporting or historical documents`);
    }
    claims.push({ text: claim.text, citations });
  }

  const conflicts = model.conflicts
    .map((c, i) => ({ description: c.description, citations: toCitations(c.citation_ids, `conflict ${i + 1}`) }))
    .filter((c) => c.citations.length > 0);
  if (conflicts.length > 0 && status === "answered") downgrade("conflicts reported");

  const modifiers = docs.filter((d) => d.role === "modifier");
  const cited = new Set(claims.flatMap((c) => c.citations.map((x) => x.id)));
  for (const m of modifiers) {
    if (m.relatedTo && cited.has(m.relatedTo) && !cited.has(m.id)) {
      downgrade(`${m.id} ${m.relation?.kind ?? "modifies"} ${m.relatedTo} but the answer ignores it`);
    }
  }

  if (status !== "refused" && claims.length === 0) {
    warnings.push("no supported claims left");
    status = "refused";
  }

  // The summary is shown to the user too, so it gets the same number check
  // against everything the surviving claims cite. On failure it is rebuilt from the claims.
  let summary = model.summary;
  const summaryAvailable = new Set(
    numbersIn(
      claims
        .flatMap((c) => c.citations)
        .flatMap((c) => byId.get(c.id)!.chunks.map((ch) => ch.text))
        .join("\n"),
    ),
  );
  const summaryInvented = numbersIn(summary).filter((n) => !summaryAvailable.has(n));
  if (summaryInvented.length > 0) {
    downgrade(`summary: ${summaryInvented.join(", ")} not found in cited text, replaced with claims`);
    summary = claims.map((c) => c.text).join(" ");
  }

  return {
    status,
    summary,
    claims: status === "refused" ? [] : claims,
    conflicts,
    missing: model.missing,
    warnings,
  };
}
