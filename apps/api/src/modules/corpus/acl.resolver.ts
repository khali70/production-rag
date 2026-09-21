import type { Permissions } from "../../domain/types.js";
import type { Entitlements } from "./pack.loader.js";

/**
 * Turns the supplied entitlements into the three group lists the search filter
 * checks. Default is deny, so every unknown resolves to an empty list, and an
 * empty allow list matches nobody.
 *
 * Visible iff:
 *   groups overlap allowedGroups
 *   AND groups overlap classificationGroups
 *   AND groups do NOT overlap denyGroups
 */
export function resolvePermissions(
  documentId: string,
  classification: string,
  allowedGroups: string[],
  entitlements: Entitlements,
): Permissions {
  const rule = entitlements.rules.find((r) => r.classification === classification);
  // Unknown classification label resolves to [] = nobody. Fail closed.
  const ruleGroups = rule?.allow_groups ?? [];

  const override = entitlements.document_overrides.find((o) => o.document_id === documentId);

  // An override's allow_groups narrows the classification rule, never widens it.
  const classificationGroups = override?.allow_groups
    ? ruleGroups.filter((g) => override.allow_groups!.includes(g))
    : ruleGroups;

  const denyGroups = override?.deny_groups ?? [];

  return {
    allowedGroups: [...allowedGroups],
    classification,
    classificationGroups,
    denyGroups: [...denyGroups],
  };
}

/** Mirrors the SQL filter. Used by tests and by any caller that needs to explain a decision. */
export function isVisibleTo(groups: string[], perms: Permissions): boolean {
  const overlaps = (list: string[]) => list.some((g) => groups.includes(g));
  if (!overlaps(perms.allowedGroups)) return false;
  if (!overlaps(perms.classificationGroups)) return false;
  if (overlaps(perms.denyGroups)) return false;
  return true;
}
