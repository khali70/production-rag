import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isVisibleTo, resolvePermissions } from "../../src/modules/corpus/acl.resolver.js";
import { entitlementsSchema } from "../../src/modules/corpus/pack.loader.js";

const PACK = resolve(import.meta.dirname, "../../../../Kentrick_Assessment_Pack_Candidate");
const entitlements = entitlementsSchema.parse(
  JSON.parse(readFileSync(resolve(PACK, "access/entitlements.json"), "utf8")),
);

const ENG = ["all_employees", "engineering"];
const HR = ["all_employees", "hr_general", "hr_investigations"];
const PROC = ["all_employees", "procurement"];

describe("acl resolver", () => {
  it("lets every employee see an INTERNAL document", () => {
    const perms = resolvePermissions("APX-HR-POL-003", "INTERNAL", ["all_employees"], entitlements);
    expect(perms.classificationGroups).toEqual(["all_employees"]);
    expect(perms.denyGroups).toEqual([]);
    for (const groups of [ENG, HR, PROC]) {
      expect(isVisibleTo(groups, perms)).toBe(true);
    }
  });

  it("restricts the HR investigation to hr_investigations only", () => {
    const perms = resolvePermissions(
      "APX-HR-CASE-778",
      "RESTRICTED_HR_INVESTIGATION",
      ["hr_investigations"],
      entitlements,
    );
    expect(isVisibleTo(HR, perms)).toBe(true);
    expect(isVisibleTo(ENG, perms)).toBe(false);
    expect(isVisibleTo(PROC, perms)).toBe(false);
  });

  it("lets a deny group beat an allow group", () => {
    const perms = resolvePermissions(
      "APX-HR-CASE-778",
      "RESTRICTED_HR_INVESTIGATION",
      ["hr_investigations"],
      entitlements,
    );
    expect(perms.denyGroups).toEqual(["engineering", "procurement"]);
    // Even handed both the allowed group and a denied one, deny wins.
    expect(isVisibleTo(["hr_investigations", "engineering"], perms)).toBe(false);
  });

  it("denies an unknown classification label instead of defaulting to allow", () => {
    const perms = resolvePermissions("DOC-X", "TOP_SECRET_UNKNOWN", ["all_employees"], entitlements);
    expect(perms.classificationGroups).toEqual([]);
    expect(isVisibleTo(HR, perms)).toBe(false);
  });

  it("denies a document whose allowed_groups is empty", () => {
    const perms = resolvePermissions("DOC-Y", "INTERNAL", [], entitlements);
    expect(isVisibleTo(HR, perms)).toBe(false);
  });

  it("narrows but never widens the classification rule with an override", () => {
    const narrowed = entitlementsSchema.parse({
      schema_version: "1.0",
      default_rule: "deny",
      rules: [{ rule_id: "r", classification: "INTERNAL", allow_groups: ["all_employees"] }],
      document_overrides: [{ document_id: "DOC-Z", allow_groups: ["finance"] }],
    });
    const perms = resolvePermissions("DOC-Z", "INTERNAL", ["all_employees"], narrowed);
    // "finance" is not in the classification rule, so the intersection is empty: nobody.
    expect(perms.classificationGroups).toEqual([]);
    expect(isVisibleTo(["finance"], perms)).toBe(false);
  });
});
