/**
 * Domain types shared by the ports and both adapters.
 * Source of the design: context/05-vector-store.md.
 */

/** Built server-side from the pack's identities.json. Never taken from a request body. */
export type AccessScope = {
  principalId: string;
  groups: string[];
  department: string;
};

// --- citation -------------------------------------------------------------

export type SourceRef = {
  documentId: string;
  version: string;
  title: string;
  sourcePath: string;
  sectionPath: string[];
  pageStart?: number;
  pageEnd?: number;
  /** Offsets into the JSONL `content` string, so a citation can be re-resolved exactly. */
  charStart: number;
  charEnd: number;
  chunkIndex: number;
};

// --- permissions ----------------------------------------------------------

export type Permissions = {
  /** Document allowed_groups. Empty means nobody. */
  allowedGroups: string[];
  classification: string;
  /** allow_groups of the matching entitlement rule. Unknown label resolves to [] = deny. */
  classificationGroups: string[];
  /** document_overrides.deny_groups. Beats every allow. */
  denyGroups: string[];
};

// --- authority ------------------------------------------------------------

/** Kind of document. Answers "what sort of thing is this". */
export type Tier =
  | "policy"
  | "delegated_standard"
  | "advisory"
  | "record"
  | "unverified";

export type Relation =
  | { kind: "supersedes"; documentId: string; version: string }
  | { kind: "amends"; documentId: string; version: string; scope: string }
  | { kind: "qualifies"; documentId: string; version: string; scope: string };

export type Authority = {
  tier: Tier;
  /** Derived from tier. Higher wins. */
  authorityRank: number;
  /**
   * Management hierarchy of the issuing authority. 0 is company-wide,
   * larger numbers are further down the org. LOWER WINS a conflict, so a
   * team-level document can never override a company-level one.
   * Independent of tier: both are compared, level first.
   */
  level: number;
  owner: string;
  relations: Relation[];
};

// --- lifecycle + soft delete ---------------------------------------------

export type Status = "current" | "superseded" | "retired";

export type Lifecycle = {
  status: Status;
  /** Status exactly as supplied, kept for audit and citations. */
  rawStatus: string;
  effectiveFrom: string;
  /** low = instruction-like patterns found at ingest. Never used as an instruction. */
  trust: "normal" | "low";
  deletedAt?: string | null;
  deletedBy?: string | null;
  deleteReason?: string | null;
};

// --- records --------------------------------------------------------------

export type DocumentRecord = {
  source: Omit<SourceRef, "sectionPath" | "charStart" | "charEnd" | "chunkIndex" | "pageStart" | "pageEnd">;
  contentSha256: string;
} & Permissions &
  Authority &
  Lifecycle;

export type ChunkRecord = {
  chunkId: string;
  text: string;
  embedding: number[];
  source: SourceRef;
  /** Hash of the document inputs, used by ingest to skip unchanged documents. */
  contentSha256: string;
} & Permissions &
  Authority &
  Lifecycle;

export type ScoredChunk = {
  chunkId: string;
  text: string;
  /** Fused RRF score. Comparable within one result set only. */
  score: number;
  /** Cosine similarity from the vector leg, or null when only full-text matched. */
  cosine: number | null;
  source: SourceRef;
  tier: Tier;
  authorityRank: number;
  level: number;
  classification: string;
  status: Status;
  trust: Lifecycle["trust"];
  effectiveFrom: string;
};

export type SearchQuery = {
  text: string;
  embedding: number[];
  topK: number;
  /** Defaults to ["current"]. */
  includeStatuses?: Status[];
  /** e.g. 90 for "what is our process" questions. Defaults to 0. */
  minAuthorityRank?: number;
  /**
   * Minimum cosine similarity between the query and the chunk embedding,
   * in [-1, 1]. Applied to every fused candidate, including ones that only the
   * full-text leg found, so a keyword hit cannot bypass it. Omit for no filter.
   */
  minCosine?: number;
  /**
   * Date the answer must be valid on, as YYYY-MM-DD. Chunks whose
   * effective_from is later are not in force yet and are excluded, whatever
   * their status. Defaults to today (UTC). Pass a fixed date for repeatable evals.
   */
  asOf?: string;
  /**
   * relevance: rank by fused score, authority only breaks ties (default).
   * precedence: rank by authority first, for conflict resolution.
   */
  orderBy?: "relevance" | "precedence";
};

export type IndexInfo = {
  embeddingModel: string;
  dim: number;
  prefixScheme: string;
};
