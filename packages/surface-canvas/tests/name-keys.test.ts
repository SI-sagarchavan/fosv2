import { describe, expect, it } from "vitest";
import { leafKeys, nameKeys, namesMatch } from "../src/health/name-keys.js";

describe("leafKeys", () => {
  it("indexes a grouped name by the leaf only", () => {
    expect(leafKeys("Spacing/spacing_4")).toEqual(["spacing_4", "spacing4"]);
    expect(leafKeys("spacing/1")).toEqual(["1"]);
  });
});

describe("nameKeys", () => {
  it("still finds spacing_4 under Spacing/spacing_4", () => {
    const keys = new Set(nameKeys("Spacing/spacing_4"));
    expect(keys.has("spacing_4")).toBe(true);
    expect(keys.has("spacingspacing4")).toBe(true);
  });
});

describe("namesMatch", () => {
  it("matches grouping and separators on the same leaf", () => {
    expect(namesMatch("spacing_4", "Spacing/spacing_4")).toBe(true);
    expect(namesMatch("spacing_4", "spacing 4")).toBe(true);
  });

  it("does not treat theme spacing_1 as a published spacing/1", () => {
    // The collision that made Bind try to import Core/spacing/1 for space.1.
    expect(namesMatch("spacing_1", "spacing/1")).toBe(false);
    const theme = new Set(leafKeys("spacing_1"));
    const published = leafKeys("spacing/1");
    expect(published.some((key) => theme.has(key))).toBe(false);
  });
});
