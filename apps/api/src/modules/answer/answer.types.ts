import type { SourceRef, Status } from "../../domain/types.js";
import type { EvidenceRole } from "./evidence.resolver.js";

/** One document that was given to the model as context. Built in code, never by the model. */
export type Source = {
  id: string;
  role: EvidenceRole;
  source: SourceRef;
};

/** retrieval mode: the chunk returned as the answer, with the scores that picked it. */
export type Match = {
  chunkId: string;
  source: SourceRef;
  status: Status;
  effectiveFrom: string;
  role: EvidenceRole;
  rerankScore: number | null;
  cosine: number | null;
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
  /** retrieval mode only: the best chunk, whose text is `text`. */
  match?: Match;
};
