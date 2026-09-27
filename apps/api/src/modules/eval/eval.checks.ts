import type { SourceRef } from "../../domain/types.js";
import type { AskResult } from "../answer/answer.service.js";
import type { EvalCase, Expect } from "./eval.cases.js";

/**
 * Pure checks for one eval run. Everything is decided from the answer object
 * and the pipeline debug data, so a check is as deterministic as the pipeline.
 */

type DocVersion = Pick<SourceRef, "documentId" | "version">;

export function matchesRef(ref: string, doc: DocVersion): boolean {
  const [id, version] = ref.split("@");
  return doc.documentId === id && (version === undefined || doc.version === version);
}

const label = (d: DocVersion) => `${d.documentId} v${d.version}`;

/** Every document version the run touched, shown or not. */
export function touchedDocs(result: AskResult): DocVersion[] {
  const { answer, debug } = result;
  const chunks = [
    ...debug.retrieved,
    ...(debug.rerank?.kept ?? []),
    ...(debug.best ? [debug.best] : []),
    ...debug.offTopic,
    ...debug.related.chunks,
    ...debug.versions.chunks,
    ...debug.evidence.flatMap((e) => e.chunks),
  ].map((c) => c.source);
  return [
    ...chunks,
    ...answer.sources.map((s) => s.source),
    ...(answer.match ? [answer.match.source] : []),
    ...(answer.amendments ?? []).map((a) => a.source),
  ];
}

/** True when any chunk behind the answer carries a restricted classification. */
export function touchesRestricted(result: AskResult): boolean {
  return result.debug.evidence.some((e) => e.chunks.some((c) => c.classification.toUpperCase().startsWith("RESTRICTED")));
}

/** Failure messages for one run of one case. Empty means pass. */
export function checkRun(expect: Expect, result: AskResult): string[] {
  const { answer } = result;
  const failures: string[] = [];
  const refused = answer.status === "refused";

  if (!expect.status.includes(answer.status)) {
    const why = answer.warnings.length > 0 ? ` (${answer.warnings.join("; ")})` : "";
    failures.push(`status ${answer.status}, expected ${expect.status.join(" or ")}${why}`);
  }

  const current = answer.sources.filter((s) => s.role !== "historical").map((s) => s.source);
  if (!refused) {
    for (const group of expect.cite) {
      if (!current.some((d) => group.some((ref) => matchesRef(ref, d)))) {
        failures.push(`does not cite ${group.join(" or ")} (cited: ${current.map(label).join(", ") || "none"})`);
      }
    }
    const text = answer.text;
    for (const p of expect.mustMatch) {
      if (!new RegExp(p, "i").test(text)) failures.push(`answer does not match /${p}/i`);
    }
  }

  for (const ref of expect.notCurrent) {
    const hit = current.find((d) => matchesRef(ref, d));
    if (hit) failures.push(`${label(hit)} is served as current evidence`);
  }

  const first = answer.sources[0]?.source;
  for (const ref of expect.notFirst) {
    if (first && matchesRef(ref, first)) failures.push(`${label(first)} is the first source`);
  }

  const touched = touchedDocs(result);
  for (const ref of expect.neverRetrieved) {
    const hit = touched.find((d) => matchesRef(ref, d));
    if (hit) failures.push(`LEAK: ${label(hit)} entered the pipeline for this user`);
  }

  const visible = [answer.message, ...answer.warnings].join("\n");
  for (const p of expect.mustNotMatch) {
    const m = visible.match(new RegExp(p, "i"));
    if (m) failures.push(`answer contains "${m[0]}" (forbidden /${p}/i)`);
  }
  return failures;
}

/** Refused or not, plus the first source document: what paraphrases must agree on. */
export function outcomeOf(result: AskResult): string {
  const { answer } = result;
  if (answer.status === "refused") return "refused";
  return `answered from ${answer.sources[0]?.source.documentId ?? "nothing"}`;
}

/**
 * Paraphrase consistency. For each group whose members disagree, every member
 * gets a failure naming the outcomes seen. Returns case id -> failures.
 */
export function checkGroups(runs: Array<{ case: EvalCase; outcomes: string[] }>): Map<string, string[]> {
  const byGroup = new Map<string, Array<{ case: EvalCase; outcomes: string[] }>>();
  for (const r of runs) {
    if (!r.case.group) continue;
    byGroup.set(r.case.group, [...(byGroup.get(r.case.group) ?? []), r]);
  }
  const failures = new Map<string, string[]>();
  for (const [group, members] of byGroup) {
    const seen = new Set(members.flatMap((m) => m.outcomes));
    if (seen.size <= 1) continue;
    const detail = members.map((m) => `${m.case.id}: ${[...new Set(m.outcomes)].join(" / ")}`).join("; ");
    for (const m of members) failures.set(m.case.id, [`paraphrase group "${group}" disagrees (${detail})`]);
  }
  return failures;
}
