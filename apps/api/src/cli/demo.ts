import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { AppModule } from "../app.module.js";
import { REPO_ROOT } from "../config/app-config.js";
import { checkRun } from "../modules/eval/eval.checks.js";
import { DEFAULT_CASES, DEMOS, casesFor, loadEvalFile, type Demo } from "../modules/eval/eval.cases.js";
import { askCase, describeProfile, loadUsers, runEval } from "../modules/eval/eval.runner.js";

/**
 * One command per spec incident, for recording. Asks the demo cases of the
 * incident from eval/cases.v1.json, as their user, through the real pipeline,
 * and prints question, user, status, answer and sources. No traces, no debug.
 *
 *   node dist/cli/demo.js wrong-policy
 *   node dist/cli/demo.js unsupported --profile llm
 *   node dist/cli/demo.js leak
 *   node dist/cli/demo.js regression     every demo case through the eval gate
 */
const TITLES: Record<Demo, string> = {
  "wrong-policy": "Incident 1: wrong policy became the answer",
  unsupported: "Incident 2: convincing unsupported answer",
  leak: "Incident 3: security failure",
  regression: "Incident 4: undetected regression",
};

const RULE = "-".repeat(78);
const indent = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cases: { type: "string", default: DEFAULT_CASES },
      profile: { type: "string" },
    },
  });
  const incident = positionals[0] as Demo | undefined;
  if (!incident || !DEMOS.includes(incident) || positionals.length > 1) {
    throw new Error(`Usage: demo <${DEMOS.join("|")}> [--profile name]`);
  }

  const file = await loadEvalFile(resolve(REPO_ROOT, values.cases!));
  const profileName = values.profile ?? file.defaultProfile;
  const profile = file.profiles[profileName];
  if (!profile) throw new Error(`--profile: no profile named "${profileName}" (have: ${Object.keys(file.profiles).join(", ")})`);
  const demos = casesFor(file, profileName).filter((c) => c.demo && (incident === "regression" || c.incident === incident));
  if (demos.length === 0) throw new Error(`no demo case for ${incident} in profile ${profileName}`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
  try {
    console.log(`\n${TITLES[incident]}`);
    console.log(`Pipeline ${describeProfile(profileName, profile)}\n`);

    if (incident === "regression") {
      console.log("Every demo case, through the same checks as `pnpm eval`:\n");
      const results = await runEval(app, {
        cases: demos,
        profile,
        repeat: 1,
        onCase: (r) => {
          const run = r.runs[0]!;
          console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.case.incident.padEnd(13)} ${r.case.user.padEnd(11)} ${run.status.padEnd(9)} ${r.case.question}`);
          for (const f of run.failures) console.log(`      - ${f}`);
        },
      });
      const passed = results.filter((r) => r.pass).length;
      const ok = passed === results.length;
      console.log(`\n${ok ? "PASSED" : "FAILED"} ${passed}/${results.length}`);
      console.log(ok ? "Exit code 0: release can ship." : "Exit code 1: release blocked.");
      return ok ? 0 : 1;
    }

    const users = await loadUsers(app);
    let failed = 0;
    for (const c of demos) {
      const user = users.get(c.user);
      if (!user) throw new Error(`Case ${c.id}: unknown user ${c.user}`);
      const result = await askCase(app, user, c, profile);
      const { answer } = result;
      const failures = checkRun(c.expect, result);
      if (failures.length > 0) failed++;

      console.log(RULE);
      console.log(`User:      ${user.userId}${user.displayName ? ` (${user.displayName})` : ""}, ${user.department}, groups: ${user.groups.join(", ")}`);
      console.log(`Question:  ${c.question}`);
      console.log(`Status:    ${answer.status.toUpperCase()}`);
      console.log(`\nAnswer:\n${indent(answer.text)}`);
      console.log(`\nSources:${answer.sources.length === 0 ? " none" : ""}`);
      for (const s of answer.sources) {
        const section = s.source.sectionPath.length > 0 ? `, ${s.source.sectionPath.join(" > ")}` : "";
        console.log(`  [${s.id}] ${s.source.title} (${s.source.documentId} v${s.source.version}${section}) - ${s.role}`);
      }
      if (answer.warnings.length > 0) {
        console.log("\nWarnings:");
        for (const w of answer.warnings) console.log(`  ! ${w}`);
      }
      console.log(`\nCheck:     ${failures.length === 0 ? "PASS" : "FAIL"} (${c.intent})`);
      for (const f of failures) console.log(`  - ${f}`);
    }
    console.log(RULE);
    return failed === 0 ? 0 : 1;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`\ndemo failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  },
);
