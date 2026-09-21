import { comparePrecedence } from "../../domain/precedence.js";
import { isAuthoritative } from "../../domain/tier.js";
import type { Relation, ScoredChunk } from "../../domain/types.js";

/**
 * Deterministic step between retrieval and generation. Versioning and
 * authority are decided here, in code, so the model only rephrases evidence
 * whose precedence is already settled (Incident 1: wrong policy became the answer).
 *
 *   primary     highest authority in the set; the answer is built from these
 *   modifier    amends / qualifies a document that is also in the set
 *   secondary   authoritative but lower than primary; fills gaps, loses on conflict
 *   supporting  record or unverified; background only, cannot establish a rule
 *   historical  superseded, retired, or an older version of a document in the set
 */
export type EvidenceRole = "primary" | "modifier" | "secondary" | "supporting" | "historical";

export type EvidenceDoc = {
  /** Prompt-local citation id: C1, C2, ... */
  id: string;
  role: EvidenceRole;
  /** Why the role was assigned, shown to the model and in diagnostics. */
  note?: string;
  /** For modifier / historical / secondary: the id of the document it relates to. */
  relatedTo?: string;
  relation?: Relation;
  /** More than one primary shares the top level and rank: the model must check for conflict. */
  equalAuthority: boolean;
  documentId: string;
  version: string;
  title: string;
  tier: ScoredChunk["tier"];
  level: number;
  authorityRank: number;
  status: ScoredChunk["status"];
  effectiveFrom: string;
  trust: ScoredChunk["trust"];
  owner: string;
  /** Retrieved chunks of this document, in document order. */
  chunks: ScoredChunk[];
};

const ROLE_ORDER: Record<EvidenceRole, number> = {
  primary: 0,
  modifier: 1,
  secondary: 2,
  supporting: 3,
  historical: 4,
};

const docKey = (documentId: string, version: string) => `${documentId}@${version}`;

type Draft = Omit<EvidenceDoc, "id" | "relatedTo"> & { relatedKey?: string; key: string };

export function resolveEvidence(chunks: ScoredChunk[]): EvidenceDoc[] {
  // 1. Group by document version. The best-scoring chunk is kept first for ranking.
  const groups = new Map<string, ScoredChunk[]>();
  for (const c of chunks) {
    const key = docKey(c.source.documentId, c.source.version);
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }

  const drafts = new Map<string, Draft>();
  for (const [key, list] of groups) {
    const head = list[0]!;
    drafts.set(key, {
      key,
      role: "secondary",
      equalAuthority: false,
      documentId: head.source.documentId,
      version: head.source.version,
      title: head.source.title,
      tier: head.tier,
      level: head.level,
      authorityRank: head.authorityRank,
      status: head.status,
      effectiveFrom: head.effectiveFrom,
      trust: head.trust,
      owner: head.owner,
      chunks: [...list].sort((a, b) => a.source.chunkIndex - b.source.chunkIndex),
    });
  }

  // 2. Versioning. An explicit supersedes relation wins over a stale status,
  //    then a non-current status, then an older version of the same document.
  for (const d of drafts.values()) {
    for (const rel of d.chunks[0]!.relations) {
      if (rel.kind !== "supersedes" || !isAuthoritative(d.tier)) continue;
      const target = drafts.get(docKey(rel.documentId, rel.version));
      if (target && target.key !== d.key) {
        target.role = "historical";
        target.note = `superseded by ${d.documentId} v${d.version}`;
        target.relatedKey = d.key;
      }
    }
  }
  for (const d of drafts.values()) {
    if (d.role !== "historical" && d.status !== "current") {
      d.role = "historical";
      d.note = `status ${d.status}`;
    }
  }
  const newestByDoc = new Map<string, Draft>();
  for (const d of drafts.values()) {
    if (d.role === "historical") continue;
    const seen = newestByDoc.get(d.documentId);
    if (!seen || d.effectiveFrom > seen.effectiveFrom) newestByDoc.set(d.documentId, d);
  }
  for (const d of drafts.values()) {
    const newest = newestByDoc.get(d.documentId);
    if (d.role !== "historical" && newest && newest.key !== d.key) {
      d.role = "historical";
      d.note = `older version; v${newest.version} is in force`;
      d.relatedKey = newest.key;
    }
  }

  // 3. Relations. A modifier is attached to its target only when the target is live in the set.
  for (const d of drafts.values()) {
    if (d.role === "historical" || !isAuthoritative(d.tier)) continue;
    for (const rel of d.chunks[0]!.relations) {
      if (rel.kind === "supersedes") continue;
      const target = drafts.get(docKey(rel.documentId, rel.version));
      if (target && target.key !== d.key && target.role !== "historical") {
        d.role = "modifier";
        d.relation = rel;
        d.relatedKey = target.key;
        d.note = `${rel.kind} ${target.documentId} v${target.version}, scope: ${rel.scope}`;
        break;
      }
    }
  }

  // 4. Authority. Among the remaining authoritative documents, every one that
  //    shares the best (level, rank) is primary; the rest are secondary.
  const contenders = [...drafts.values()]
    .filter((d) => d.role === "secondary")
    .sort((a, b) => comparePrecedence(a.chunks[0]!, b.chunks[0]!));
  for (const d of contenders) {
    if (!isAuthoritative(d.tier)) {
      d.role = "supporting";
      d.note = `${d.tier}: background only, cannot set a rule`;
    }
  }
  const authoritative = contenders.filter((d) => d.role === "secondary");
  const top = authoritative[0];
  if (top) {
    const primaries = authoritative.filter((d) => d.level === top.level && d.authorityRank === top.authorityRank);
    for (const d of primaries) {
      d.role = "primary";
      d.equalAuthority = primaries.length > 1;
    }
    for (const d of authoritative) {
      if (d.role === "secondary") {
        d.relatedKey = top.key;
        d.note = `lower authority than ${top.documentId} (level ${d.level} vs ${top.level}, rank ${d.authorityRank} vs ${top.authorityRank})`;
      }
    }
  }

  // 5. Stable order for the prompt: role, then precedence. Ids follow that order.
  const ordered = [...drafts.values()].sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || comparePrecedence(a.chunks[0]!, b.chunks[0]!),
  );
  const idByKey = new Map(ordered.map((d, i) => [d.key, `C${i + 1}`]));

  return ordered.map(({ key, relatedKey, ...d }) => ({
    ...d,
    id: idByKey.get(key)!,
    relatedTo: relatedKey ? idByKey.get(relatedKey) : undefined,
  }));
}
