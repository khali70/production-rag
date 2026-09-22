import type { SourceRef } from "../../domain/types.js";
import type { EvidenceRole } from "./evidence.resolver.js";

/** One document that was given to the model as context. Built in code, never by the model. */
export type Source = {
  id: string;
  role: EvidenceRole;
  source: SourceRef;
};

/** What the service returns. The model writes plain text; everything else is added in code. */
export type Answer = {
  status: "answered" | "qualified" | "refused";
  /** The model's answer text, without the sources block. */
  text: string;
  /** What the user sees: text, then the sources appended at the end. */
  message: string;
  /** Documents the model was given, in prompt order. Empty on a refusal. */
  sources: Source[];
  /** Why the answer was downgraded or refused. Safe to show: no document text. */
  warnings: string[];
};
