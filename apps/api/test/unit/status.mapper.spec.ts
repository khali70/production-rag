import { describe, expect, it } from "vitest";
import {
  capsToUnverified,
  mapStatus,
  UnknownStatusError,
} from "../../src/modules/corpus/status.mapper.js";

describe("status mapper", () => {
  it.each([
    ["Current", "current"],
    ["Active", "current"],
    ["Active advisory", "current"],
    ["Open", "current"],
    ["Unverified", "current"],
    ["Retired", "retired"],
  ] as const)("maps %s to %s", (raw, expected) => {
    expect(mapStatus(raw, "DOC-1")).toBe(expected);
  });

  it("fails closed on an unrecognised status rather than assuming current", () => {
    expect(() => mapStatus("Probably fine", "DOC-1")).toThrow(UnknownStatusError);
  });

  it("caps an Unverified document at the lowest tier", () => {
    expect(capsToUnverified("Unverified")).toBe(true);
    expect(capsToUnverified("Current")).toBe(false);
  });
});
