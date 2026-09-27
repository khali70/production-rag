import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AppModule } from "../app.module.js";
import { REPO_ROOT } from "../config/app-config.js";
import { EmbeddingPort } from "../ports/embedding.port.js";
import { LlmPort } from "../ports/llm.port.js";
import { RerankerPort } from "../ports/reranker.port.js";
import { DEFAULT_CASES, INCIDENTS, casesFor, loadEvalFile, resultsPathFor, type Incident } from "../modules/eval/eval.cases.js";
import { describeProfile, runEval, toResultsJson, type CaseResult } from "../modules/eval/eval.runner.js";

/**
 * Release gate: asks every eval case through the real pipeline as its user
 * and checks the outcome in code. The last line is `PASSED n/m` or
 * `FAILED n/m`; any failure exits 1.
 *
 *   node dist/cli/eval.js
 *   node dist/cli/eval.js --profile llm
 *   node dist/cli/eval.js --incident leak --repeat 2
 *   node dist/cli/eval.js --case wrong-policy-threshold
 *
 * A full run (no --incident / --case) writes its results next to the cases
 * file: eval/cases.v1.json -> eval/results.v1.<profile>.json.
 */
function printCase(r: CaseResult): void {
  const last = r.runs[r.runs.length - 1]!;
  const statuses = [...new Set(r.runs.map((x) => x.status))].join("/");
  const first = last.result?.answer.sources[0]?.source;
  const cited = first ? `${first.documentId} v${first.version}` : "-";
  const secs = (r.runs.reduce((s, x) => s + x.ms, 0) / r.runs.length / 1000).toFixed(1);
  console.log(
    `${r.pass ? "PASS" : "FAIL"}  ${r.case.id.padEnd(34)} ${r.case.user.padEnd(11)} ${statuses.padEnd(10)} ${cited.padEnd(26)} ${secs.padStart(5)} s`,
  );
  const failures = [...new Set(r.runs.flatMap((x, i) => x.failures.map((f) => (r.runs.length > 1 ? `run ${i + 1}: ${f}` : f))))];
  for (const f of failures) console.log(`      - ${f}`);
  if (failures.length > 0) console.log(`        (${r.case.intent})`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      cases: { type: "string", default: DEFAULT_CASES },
      profile: { type: "string" },
      incident: { type: "string" },
      case: { type: "string" },
      demo: { type: "boolean", default: false },
      repeat: { type: "string", default: "1" },
      results: { type: "string" },
    },
  });

  const casesPath = resolve(REPO_ROOT, values.cases!);
  const file = await loadEvalFile(casesPath);
  const profileName = values.profile ?? file.defaultProfile;
  const profile = file.profiles[profileName];
  if (!profile) throw new Error(`--profile: no profile named "${profileName}" (have: ${Object.keys(file.profiles).join(", ")})`);
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error(`--repeat must be a positive integer, got "${values.repeat}"`);

  const incidents = values.incident?.split(",").map((s) => s.trim());
  for (const i of incidents ?? []) {
    if (!INCIDENTS.includes(i as Incident)) throw new Error(`--incident: unknown "${i}" (have: ${INCIDENTS.join(", ")})`);
  }
  const ids = values.case?.split(",").map((s) => s.trim());
  const cases = casesFor(file, profileName).filter(
    (c) => (!incidents || incidents.includes(c.incident)) && (!ids || ids.includes(c.id)) && (!values.demo || c.demo),
  );
  if (ids) {
    const missing = ids.filter((id) => !cases.some((c) => c.id === id));
    if (missing.length > 0) throw new Error(`--case: no case ${missing.join(", ")} for profile ${profileName}`);
  }
  if (cases.length === 0) throw new Error("no cases selected");
  const filtered = Boolean(incidents || ids || values.demo);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
  try {
    const models = {
      embedding: app.get(EmbeddingPort).modelId,
      reranker: app.get(RerankerPort).modelId,
      llm: app.get(LlmPort).info.id,
    };
    console.log(`Eval ${relative(REPO_ROOT, casesPath)} (v${file.version}), ${cases.length} cases${repeat > 1 ? `, each ${repeat} times` : ""}`);
    console.log(`Profile ${describeProfile(profileName, profile)}`);
    console.log(`Models: ${models.embedding} | ${models.reranker}${profile.mode === "llm" ? ` | ${models.llm}` : ""}\n`);

    const startedAt = new Date();
    const results = await runEval(app, { cases, profile, repeat, onCase: printCase });

    const grouped = results.filter((r) => r.groupFailures.length > 0);
    if (grouped.length > 0) {
      console.log("\nParaphrase consistency:");
      for (const r of grouped) console.log(`FAIL  ${r.case.id}\n      - ${r.groupFailures.join("\n      - ")}`);
    }

    console.log("");
    for (const incident of INCIDENTS) {
      const mine = results.filter((r) => r.case.incident === incident);
      if (mine.length > 0) console.log(`${incident.padEnd(14)} ${mine.filter((r) => r.pass).length}/${mine.length}`);
    }

    const passed = results.filter((r) => r.pass).length;
    const out = values.results ? resolve(REPO_ROOT, values.results) : filtered ? null : resultsPathFor(casesPath, profileName);
    if (out) {
      const json = toResultsJson(
        { casesFile: relative(REPO_ROOT, casesPath), version: file.version, profileName, profile, repeat, models, startedAt },
        results,
      );
      await writeFile(out, `${JSON.stringify(json, null, 2)}\n`, "utf8");
      console.log(`\nResults: ${relative(REPO_ROOT, out)}`);
    } else {
      console.log("\nResults not written: filtered run (pass --results <path> to keep them).");
    }
    console.log(`${passed === results.length ? "PASSED" : "FAILED"} ${passed}/${results.length}`);
    return passed === results.length ? 0 : 1;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`\neval failed: ${err instanceof Error ? err.message : String(err)}`);
    console.log("FAILED 0/0");
    process.exitCode = 2;
  },
);
