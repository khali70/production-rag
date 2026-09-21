import { z } from "zod";
import type { SourceRef } from "../../domain/types.js";
import type { EvidenceRole } from "./evidence.resolver.js";

/** What the model must return. Never free text. */
export const ModelAnswerSchema = z.strictObject({
  status: z.enum(["answered", "qualified", "refused"]),
  summary: z.string(),
  claims: z.array(
    z.strictObject({
      text: z.string(),
      citation_ids: z.array(z.string()),
    }),
  ),
  conflicts: z.array(
    z.strictObject({
      description: z.string(),
      citation_ids: z.array(z.string()),
    }),
  ),
  missing: z.array(z.string()),
});

export type ModelAnswer = z.infer<typeof ModelAnswerSchema>;

export const MODEL_ANSWER_JSON_SCHEMA = {
  name: "grounded_answer",
  schema: z.toJSONSchema(ModelAnswerSchema) as object,
};

export type Citation = {
  id: string;
  role: EvidenceRole;
  source: SourceRef;
};

/** What the service returns after validation. Citations are built in code, not by the model. */
export type Answer = {
  status: "answered" | "qualified" | "refused";
  summary: string;
  claims: { text: string; citations: Citation[] }[];
  conflicts: { description: string; citations: Citation[] }[];
  missing: string[];
  /** Why the validator downgraded or dropped something. Safe to show: no document text. */
  warnings: string[];
};
