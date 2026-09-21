import { Injectable } from "@nestjs/common";
import { authorityKey, type AuthorityEntry, type AuthorityIndex } from "./authority.loader.js";
import type { CorpusRecord } from "./pack.loader.js";
import { capsToUnverified } from "./status.mapper.js";

/**
 * Cross-checks the reviewed authority layer against what the documents
 * actually say, before any of it reaches the database.
 *
 * The point is that authority can never be asserted from outside the evidence:
 * if data/authority.yaml claims an owner, a supersede, or a tier that the
 * document text does not support, ingest fails. Equally, a document cannot
 * promote itself: an Unverified status forces the lowest tier whatever the
 * content claims about its own priority.
 */
export class AuthorityMismatchError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `data/authority.yaml does not match the corpus:\n${problems.map((p) => `  ${p}`).join("\n")}`,
    );
    this.name = "AuthorityMismatchError";
  }
}

/** PDF-derived text wraps mid-sentence, so quotes are compared on collapsed whitespace. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Reads an explicit owner cue from the document text.
 * Two shapes appear in the pack: "Owner | Name" (docx) and "Owner\nName" (pdf).
 */
function ownerCue(content: string): string | null {
  const piped = /^Owner\s*\|\s*(.+)$/m.exec(content);
  if (piped) return piped[1]!.trim();

  const lines = content.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i]!.trim() === "Owner") {
      const next = lines[i + 1]!.trim();
      if (next.length > 0) return next;
    }
  }
  return null;
}

@Injectable()
export class AuthorityCrossCheck {
  /** Throws AuthorityMismatchError listing every problem found, or returns silently. */
  check(records: CorpusRecord[], index: AuthorityIndex): void {
    const problems: string[] = [];
    const corpusKeys = new Set(records.map((r) => authorityKey(r.document_id, r.version)));

    for (const key of index.keys()) {
      if (!corpusKeys.has(key)) {
        problems.push(`${key}: authority entry has no matching corpus record`);
      }
    }

    for (const record of records) {
      const key = authorityKey(record.document_id, record.version);
      const entry = index.get(key);
      if (!entry) {
        problems.push(`${key}: no authority entry. Every document needs a reviewed tier and level.`);
        continue;
      }
      problems.push(...this.checkOne(record, entry, corpusKeys));
    }

    if (problems.length > 0) throw new AuthorityMismatchError(problems);
  }

  private checkOne(
    record: CorpusRecord,
    entry: AuthorityEntry,
    corpusKeys: Set<string>,
  ): string[] {
    const problems: string[] = [];
    const key = authorityKey(record.document_id, record.version);
    const content = normalize(record.content);

    // 1. Every evidence quote must actually appear in the document.
    for (const quote of entry.evidence) {
      if (!content.includes(normalize(quote))) {
        problems.push(`${key}: evidence quote not found in content: "${quote}"`);
      }
    }
    if (entry.delegation_evidence) {
      problems.push(...this.checkDelegation(key, entry, corpusKeys));
    }

    // 2. A stated owner must match; an absent one must be declared inferred.
    const cue = ownerCue(record.content);
    if (cue === null) {
      if (!entry.owner_inferred) {
        problems.push(
          `${key}: content states no owner, so owner "${entry.owner}" must be marked owner_inferred: true`,
        );
      }
    } else if (normalize(cue) !== normalize(entry.owner)) {
      problems.push(`${key}: content says owner "${cue}", authority.yaml says "${entry.owner}"`);
    }

    const relationTargets = new Set(
      entry.relations.map((r) => authorityKey(r.document_id, r.version)),
    );
    const supersedeTargets = new Set(
      entry.relations
        .filter((r) => r.kind === "supersedes")
        .map((r) => r.document_id),
    );

    // 3. A supersede cue in the text needs a matching relation.
    //    Matched narrowly on purpose: the approval matrix says it "supersedes
    //    threshold tables embedded in earlier policy copies", which is a scope
    //    statement, not a version supersede, and must not trip this.
    const supersedeCue =
      /Supersedes\s*\|\s*Version\s+([\d.]+)/i.exec(record.content) ??
      /Version\s+[\d.]+\s+supersedes\s+version\s+([\d.]+)/i.exec(normalize(record.content));
    if (supersedeCue) {
      const target = authorityKey(record.document_id, supersedeCue[1]!);
      if (!relationTargets.has(target)) {
        problems.push(
          `${key}: content states it supersedes version ${supersedeCue[1]}, but no matching supersedes relation exists`,
        );
      }
    }

    // 4. "does not supersede X" forbids claiming a supersede over X.
    for (const match of normalize(record.content).matchAll(
      /does not supersede\s+([A-Z][A-Z0-9-]+)/gi,
    )) {
      const target = match[1]!;
      if (supersedeTargets.has(target)) {
        problems.push(
          `${key}: content says it does not supersede ${target}, but a supersedes relation claims otherwise`,
        );
      }
    }

    // 5. "Related policy X version V" needs an amends or qualifies relation.
    const related = /Related policy\s+([A-Z][A-Z0-9-]+)\s+version\s+([\d.]+)/i.exec(content);
    if (related) {
      const target = authorityKey(related[1]!, related[2]!);
      const hasScoped = entry.relations.some(
        (r) =>
          (r.kind === "amends" || r.kind === "qualifies") &&
          authorityKey(r.document_id, r.version) === target,
      );
      if (!hasScoped) {
        problems.push(
          `${key}: content names related policy ${target}, but no amends or qualifies relation targets it`,
        );
      }
    }

    // 6. Relation targets must exist in the corpus.
    for (const relation of entry.relations) {
      const target = authorityKey(relation.document_id, relation.version);
      if (!corpusKeys.has(target)) {
        problems.push(`${key}: relation target ${target} is not in the corpus`);
      }
      if (target === key) {
        problems.push(`${key}: relation targets itself`);
      }
    }

    // 7. An unverified document is never authoritative, whatever it claims.
    if (capsToUnverified(record.status)) {
      if (entry.tier !== "unverified") {
        problems.push(
          `${key}: supplied status is Unverified, so tier must be "unverified", not "${entry.tier}"`,
        );
      }
      if (entry.relations.length > 0) {
        problems.push(`${key}: an unverified document cannot supersede, amend or qualify anything`);
      }
    }

    return problems;
  }

  private checkDelegation(
    key: string,
    entry: AuthorityEntry,
    corpusKeys: Set<string>,
  ): string[] {
    const delegation = entry.delegation_evidence!;
    const target = authorityKey(delegation.document_id, delegation.version);
    if (!corpusKeys.has(target)) {
      return [`${key}: delegation_evidence names ${target}, which is not in the corpus`];
    }
    return [];
  }

  /**
   * Verifies the delegation quote against the delegating document's content.
   * Separate from checkOne because it reads a different record.
   */
  checkDelegationQuotes(records: CorpusRecord[], index: AuthorityIndex): void {
    const byKey = new Map(records.map((r) => [authorityKey(r.document_id, r.version), r]));
    const problems: string[] = [];

    for (const [key, entry] of index) {
      const delegation = entry.delegation_evidence;
      if (!delegation) continue;
      const source = byKey.get(authorityKey(delegation.document_id, delegation.version));
      if (!source) continue; // already reported by checkOne
      if (!normalize(source.content).includes(normalize(delegation.quote))) {
        problems.push(
          `${key}: delegation quote not found in ${delegation.document_id} v${delegation.version}: "${delegation.quote}"`,
        );
      }
    }

    if (problems.length > 0) throw new AuthorityMismatchError(problems);
  }
}
