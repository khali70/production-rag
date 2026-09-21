import type { Status } from "../../domain/types.js";

/**
 * Maps the supplied `status` string onto our lifecycle status.
 *
 * Fails closed: an unrecognised value aborts ingest rather than defaulting to
 * `current`. A document whose state we cannot read is worse than no document.
 */
const RAW_TO_STATUS: Readonly<Record<string, Status>> = Object.freeze({
  current: "current",
  active: "current",
  "active advisory": "current",
  open: "current",
  retired: "retired",
  superseded: "superseded",
  // Unverified is still "current" in time, but tier caps it at `unverified`
  // so it is never authoritative. Handled by capsToUnverified below.
  unverified: "current",
});

export class UnknownStatusError extends Error {
  constructor(rawStatus: string, documentId: string) {
    super(
      `Unknown status "${rawStatus}" on ${documentId}. Refusing to guess. ` +
        `Add an explicit mapping in status.mapper.ts if this status is legitimate.`,
    );
    this.name = "UnknownStatusError";
  }
}

export function mapStatus(rawStatus: string, documentId: string): Status {
  const status = RAW_TO_STATUS[rawStatus.trim().toLowerCase()];
  if (!status) throw new UnknownStatusError(rawStatus, documentId);
  return status;
}

/**
 * True when the supplied status alone forces the lowest authority tier,
 * regardless of what the document's own text claims about itself.
 */
export function capsToUnverified(rawStatus: string): boolean {
  return rawStatus.trim().toLowerCase() === "unverified";
}
