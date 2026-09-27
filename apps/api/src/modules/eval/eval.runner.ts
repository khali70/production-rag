import type { INestApplicationContext } from "@nestjs/common";
import type { AccessScope } from "../../domain/types.js";
import { AnswerService, type AskOptions, type AskResult } from "../answer/answer.service.js";
import { PackLoader } from "../corpus/pack.loader.js";
import { toAskOptions } from "../http/ask.request.js";
import { checkGroups, checkRun, outcomeOf, touchesRestricted } from "./eval.checks.js";
import type { EvalCase, EvalFile, Profile } from "./eval.cases.js";

export type PackUser = { userId: string; displayName: string | null; department: string; groups: string[] };

export type CaseRun = {
  status: AskResult["answer"]["status"];
  pass: boolean;
  failures: string[];
  outcome: string;
  ms: number;
  result?: AskResult;
};

export type CaseResult = {
  case: EvalCase;
  user: PackUser;
  runs: CaseRun[];
  /** Paraphrase-group failures, added after every case has run. */
  groupFailures: string[];
  pass: boolean;
};

/** Same conversion as POST /api/ask, so a profile behaves exactly like the playground or API with those settings. */
export function profileOptions(profile: Profile, c: Pick<EvalCase, "user" | "question">): AskOptions {
  return toAskOptions({ ...profile, userId: c.user, question: c.question });
}

export function describeProfile(name: string, p: Profile): string {
  const rerank = p.rerank ? `rerank pool ${p.rerank.pool} min ${p.rerank.minScore}` : "no rerank";
  return `${name}: mode ${p.mode}, k ${p.k}, ${p.order}, ${rerank}, gate ${p.gateCosine}, statuses ${p.statuses.join("+")}, as of ${p.asOf ?? "today"}`;
}

export async function loadUsers(app: INestApplicationContext): Promise<Map<string, PackUser>> {
  const { users } = await app.get(PackLoader).loadIdentities();
  return new Map(
    users.map((u) => [
      u.user_id,
      { userId: u.user_id, displayName: u.display_name ?? null, department: u.department, groups: u.groups },
    ]),
  );
}

/** Ask one case as its user, through the real pipeline. Groups come from identities.json, never from the case. */
export async function askCase(app: INestApplicationContext, user: PackUser, c: EvalCase, profile: Profile): Promise<AskResult> {
  const scope: AccessScope = { principalId: user.userId, groups: user.groups, department: user.department };
  return app.get(AnswerService).ask(scope, c.question, profileOptions(profile, c));
}

/**
 * Runs every case `repeat` times, then checks paraphrase groups across all
 * runs. A case passes only when every run and its group pass.
 */
export async function runEval(
  app: INestApplicationContext,
  opts: { cases: EvalCase[]; profile: Profile; repeat: number; onCase?: (r: CaseResult) => void },
): Promise<CaseResult[]> {
  const users = await loadUsers(app);
  const results: CaseResult[] = [];
  for (const c of opts.cases) {
    const user = users.get(c.user);
    if (!user) throw new Error(`Case ${c.id}: unknown user ${c.user}. Users come from the pack's identities.json.`);
    const runs: CaseRun[] = [];
    for (let i = 0; i < opts.repeat; i++) {
      const started = Date.now();
      try {
        const result = await askCase(app, user, c, opts.profile);
        const failures = checkRun(c.expect, result);
        runs.push({ status: result.answer.status, pass: failures.length === 0, failures, outcome: outcomeOf(result), ms: Date.now() - started, result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        runs.push({ status: "refused", pass: false, failures: [`pipeline error: ${msg}`], outcome: "error", ms: Date.now() - started });
      }
    }
    const r: CaseResult = { case: c, user, runs, groupFailures: [], pass: runs.every((x) => x.pass) };
    results.push(r);
    // Group failures are only known at the end; the live line shows the case's own checks.
    opts.onCase?.(r);
  }
  const groups = checkGroups(results.map((r) => ({ case: r.case, outcomes: r.runs.map((x) => x.outcome) })));
  for (const r of results) {
    r.groupFailures = groups.get(r.case.id) ?? [];
    if (r.groupFailures.length > 0) r.pass = false;
  }
  return results;
}

/** JSON written next to the cases file. Answer text is omitted when restricted evidence was behind it. */
export function toResultsJson(
  meta: { casesFile: string; version: string; profileName: string; profile: Profile; repeat: number; models: Record<string, string>; startedAt: Date },
  results: CaseResult[],
) {
  const passed = results.filter((r) => r.pass).length;
  return {
    casesFile: meta.casesFile,
    casesVersion: meta.version,
    profile: meta.profileName,
    settings: meta.profile,
    models: meta.models,
    repeat: meta.repeat,
    startedAt: meta.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    summary: { passed, total: results.length, verdict: passed === results.length ? "PASSED" : "FAILED" },
    cases: results.map((r) => ({
      id: r.case.id,
      incident: r.case.incident,
      user: r.case.user,
      question: r.case.question,
      pass: r.pass,
      groupFailures: r.groupFailures,
      runs: r.runs.map((run) => ({
        pass: run.pass,
        status: run.status,
        failures: run.failures,
        ms: run.ms,
        sources: run.result?.answer.sources.map((s) => `${s.id} ${s.source.documentId} v${s.source.version} ${s.role}`) ?? [],
        warnings: run.result?.answer.warnings ?? [],
        answer: !run.result ? null : touchesRestricted(run.result) ? "[omitted: restricted evidence]" : run.result.answer.text,
      })),
    })),
  };
}
