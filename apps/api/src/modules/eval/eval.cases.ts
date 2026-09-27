import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { AskRequestSchema } from "../http/ask.request.js";

/**
 * Versioned eval cases for the four spec incidents. One JSON file holds the
 * run profiles (pipeline settings, same shape and defaults as POST /api/ask)
 * and the cases. Every case is asked through the real pipeline and checked in
 * code: no model grades another model.
 */

/**
 * Spec incidents 1-3 each have cases. Incident 4 (undetected regression) is
 * the eval itself: `pnpm demo regression` runs the demo cases through it.
 */
export const INCIDENTS = ["wrong-policy", "unsupported", "leak"] as const;
export type Incident = (typeof INCIDENTS)[number];
export const DEMOS = [...INCIDENTS, "regression"] as const;
export type Demo = (typeof DEMOS)[number];

/** "APX-PROC-POL-014" matches any version, "APX-PROC-POL-014@3.0" one version. */
const DocRef = z.string().regex(/^[A-Z0-9-]+(@[\w.]+)?$/, 'expected "DOC-ID" or "DOC-ID@version"');

/** A JavaScript regex source, matched case-insensitively. Checked at load so a typo fails before any model runs. */
const Pattern = z.string().min(1).refine(
  (p) => {
    try {
      new RegExp(p, "i");
      return true;
    } catch {
      return false;
    }
  },
  { message: "invalid regular expression" },
);

export const ExpectSchema = z.strictObject({
  /** Allowed outcomes. */
  status: z.array(z.enum(["answered", "qualified", "refused"])).min(1),
  /**
   * When not refused: each group needs at least one member among the sources
   * in a non-historical role (primary, modifier, secondary, supporting).
   */
  cite: z.array(z.array(DocRef).min(1)).default([]),
  /** Must never be a source in a non-historical role: an old version must not be served as current. */
  notCurrent: z.array(DocRef).default([]),
  /** Must not be the first (highest-priority) source. */
  notFirst: z.array(DocRef).default([]),
  /**
   * Leak check: must not appear anywhere in the run, including chunks that
   * were retrieved but never shown (search, related, other versions, evidence).
   */
  neverRetrieved: z.array(DocRef).default([]),
  /** When not refused: each pattern must match the answer text. */
  mustMatch: z.array(Pattern).default([]),
  /** No pattern may match the answer message or its warnings, whatever the status. */
  mustNotMatch: z.array(Pattern).default([]),
});
export type Expect = z.infer<typeof ExpectSchema>;

export const EvalCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  incident: z.enum(INCIDENTS),
  /** What the case proves, one line, shown when it fails. */
  intent: z.string().min(1),
  user: z.string().min(1),
  question: z.string().trim().min(1),
  /**
   * Paraphrases of one question share a group. Every member must reach the
   * same outcome: refused or not, and the same first source document.
   */
  group: z.string().optional(),
  /** Shown by `pnpm demo <incident>`, in file order. */
  demo: z.boolean().default(false),
  /** Limit the case to some profiles. Default: all. */
  profiles: z.array(z.string()).optional(),
  expect: ExpectSchema,
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

/** POST /api/ask body without the user and question: the same validation and defaults as the API. */
export const ProfileSchema = AskRequestSchema.omit({ userId: true, question: true });
export type Profile = z.infer<typeof ProfileSchema>;

export const EvalFileSchema = z
  .strictObject({
    $comment: z.string().optional(),
    version: z.string().min(1),
    defaultProfile: z.string().min(1),
    profiles: z.record(z.string(), ProfileSchema),
    cases: z.array(EvalCaseSchema).min(1),
  })
  .superRefine((file, ctx) => {
    if (!(file.defaultProfile in file.profiles)) {
      ctx.addIssue({ code: "custom", path: ["defaultProfile"], message: `no profile named "${file.defaultProfile}"` });
    }
    const seen = new Set<string>();
    file.cases.forEach((c, i) => {
      if (seen.has(c.id)) ctx.addIssue({ code: "custom", path: ["cases", i, "id"], message: `duplicate case id "${c.id}"` });
      seen.add(c.id);
      for (const p of c.profiles ?? []) {
        if (!(p in file.profiles)) ctx.addIssue({ code: "custom", path: ["cases", i, "profiles"], message: `no profile named "${p}"` });
      }
    });
  });
export type EvalFile = z.infer<typeof EvalFileSchema>;

export async function loadEvalFile(path: string): Promise<EvalFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read eval cases ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = EvalFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid eval cases ${path}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function casesFor(file: EvalFile, profile: string): EvalCase[] {
  return file.cases.filter((c) => !c.profiles || c.profiles.includes(profile));
}

/** Relative to the repo root. */
export const DEFAULT_CASES = "eval/cases.v1.json";

/** Results live next to the cases: eval/cases.v1.json -> eval/results.v1.<profile>.json. */
export function resultsPathFor(casesPath: string, profile: string): string {
  const name = basename(casesPath, ".json");
  const out = name.startsWith("cases") ? `results${name.slice("cases".length)}.${profile}.json` : `${name}.results.${profile}.json`;
  return join(dirname(casesPath), out);
}
