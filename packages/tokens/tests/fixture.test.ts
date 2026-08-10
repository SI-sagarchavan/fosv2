/**
 * Acceptance criteria against the real Southern Brave export.
 *
 * These numbers are the contract with the design system. If one of them moves,
 * either the export changed or a rule regressed — both need a human.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { errorClasses, findingsByCode, validateTheme } from "../src/validate.js";
import { parseThemeJson } from "../src/load.js";
import { loadSurfaces } from "../src/load.js";
import { toCanonical, toRaw, typeIntersection, typeUnion } from "../src/normalize.js";
import { TOKEN_CATEGORIES } from "../src/types.js";

const FIXTURE = new URL("../fixtures/southern-brave.json", import.meta.url);
const SURFACES = new URL("../surfaces/southern-brave.json", import.meta.url);

function rawFixture(): { tokens: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

function theme() {
  return parseThemeJson(rawFixture())[0]!;
}

describe("the export as it stands", () => {
  it("normalizes to the expected scale sizes", () => {
    const t = theme();
    expect(t.name).toBe("Style Southern Brave");
    expect(t.slug).toBe("style-southern-brave");
    expect(t.color.light.size).toBe(163);
    expect(t.color.dark.size).toBe(0);
    expect(t.space.size).toBe(21);
    expect(t.radius.size).toBe(8);
    expect(t.opacity.size).toBe(11);
    expect(t.gradient.light.size).toBe(22);
    expect(t.shadow.light.size).toBe(5);
    expect(t.type.mobile.size).toBe(32);
    expect(t.type.tablet.size).toBe(32);
    expect(t.type.desktop.size).toBe(31);
  });

  it("has 33 type keys in union and 30 in intersection", () => {
    expect(typeUnion(theme())).toHaveLength(33);
    expect(typeIntersection(theme())).toHaveLength(30);
  });

  it("fails with exactly two error classes", () => {
    const result = validateTheme(theme(), { surfaces: loadSurfaces(SURFACES.pathname) });
    expect(result.ok).toBe(false);
    expect(errorClasses(result)).toEqual(["E1", "E6"]);
  });

  it("E1 names exactly h3_medium, xl_medium and xl_regular, with the right breakpoints", () => {
    const findings = findingsByCode(validateTheme(theme()), "E1");
    expect(findings.map((f) => f.data)).toEqual([
      { key: "h3_medium", present: ["desktop"], missing: ["mobile", "tablet"] },
      { key: "xl_medium", present: ["mobile", "tablet"], missing: ["desktop"] },
      { key: "xl_regular", present: ["mobile", "tablet"], missing: ["desktop"] },
    ]);
  });

  it("E6 names core_sec_500 == core_sec_600 == #2939a3", () => {
    const findings = findingsByCode(validateTheme(theme()), "E6");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data).toMatchObject({
      family: "sec",
      value: "#2939a3",
      names: ["core_sec_500", "core_sec_600"],
    });
  });

  it("reports the expected warnings and info", () => {
    const result = validateTheme(theme(), { surfaces: loadSurfaces(SURFACES.pathname) });
    expect(result.counts.W1).toBe(1);
    expect(result.counts.W2).toBe(5);
    expect(result.counts.W3).toBe(4);
    expect(result.counts.W4).toBe(5);
    expect(result.counts.W5).toBe(1);
    expect(result.counts.W6).toBe(0);
    expect(result.counts.I1).toBe(1);
    expect(result.counts.E4).toBe(0);
    expect(result.counts.E5).toBe(0);
  });

  it("W1 is background_sec_card2 / background_sec_card_2", () => {
    const [finding] = findingsByCode(validateTheme(theme()), "W1");
    expect(finding?.data).toMatchObject({ names: ["background_sec_card2", "background_sec_card_2"] });
  });

  it("W2 is the five drop shadows, all opaque", () => {
    const paths = findingsByCode(validateTheme(theme()), "W2").map((f) => f.path);
    expect(paths).toEqual([
      "shadow.light.drop_shadow_lg",
      "shadow.light.drop_shadow_md",
      "shadow.light.drop_shadow_sm",
      "shadow.light.drop_shadow_xl",
      "shadow.light.drop_shadow_xs",
    ]);
  });

  it("W3 is the four xl_* styles on mobile and tablet", () => {
    const findings = findingsByCode(validateTheme(theme()), "W3");
    expect(findings.map((f) => `${f.data?.breakpoint}.${f.data?.key} ${f.data?.weight}!=${f.data?.expected}`)).toEqual([
      "mobile.xl_medium 700!=500",
      "mobile.xl_regular 500!=400",
      "tablet.xl_medium 700!=500",
      "tablet.xl_regular 500!=400",
    ]);
  });

  it("W4 is the five empty categories", () => {
    const paths = findingsByCode(validateTheme(theme()), "W4").map((f) => f.path);
    expect(paths).toEqual(["badge.size", "button.size", "color.dark", "gradient.dark", "shadow.dark"]);
  });

  it("W5 is one aggregate line covering all 95 styles", () => {
    // 32 mobile + 32 tablet + 31 desktop. Reported once, not 95 times.
    const findings = findingsByCode(validateTheme(theme()), "W5");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data).toMatchObject({ total: 95 });
  });

  it("I1 reports 163 -> 61", () => {
    const [finding] = findingsByCode(validateTheme(theme()), "I1");
    expect(finding?.data).toMatchObject({ names: 163, distinct: 61 });
    expect(finding?.message).toContain("163 -> 61");
  });

  it("the surfaces file resolves cleanly", () => {
    const result = validateTheme(theme(), { surfaces: loadSurfaces(SURFACES.pathname) });
    expect(findingsByCode(result, "E2")).toEqual([]);
    expect(findingsByCode(result, "E3")).toEqual([]);
  });
});

describe("with E1 and E6 fixed", () => {
  /**
   * Patches the two errors and nothing else:
   *   - desktop gains xl_medium / xl_regular at the weights their names promise
   *   - mobile and tablet gain desktop's h3_medium
   *   - core_sec_600 moves off #2939a3 onto a value already in the palette, so
   *     the alias-density ratio is untouched
   */
  function fixed() {
    const raw = rawFixture();
    const body = Object.values(raw.tokens)[0]! as Record<string, Record<string, unknown>>;

    const desktop = body["typography_desktop"]! as Record<string, Record<string, unknown>>;
    const mobile = body["typography_mobile"]! as Record<string, Record<string, unknown>>;
    const tablet = body["typography_tablet"]! as Record<string, Record<string, unknown>>;

    for (const bp of [mobile, tablet]) bp["h3_medium"] = { ...desktop["h3_medium"]! };
    desktop["xl_medium"] = { ...mobile["xl_medium"]!, weight: 500 };
    desktop["xl_regular"] = { ...mobile["xl_regular"]!, weight: 400 };

    const color = body["color"]! as Record<string, Record<string, string>>;
    color["light"]!["core_sec_600"] = "#757575";

    return parseThemeJson(raw)[0]!;
  }

  it("passes, with the warning profile unchanged", () => {
    const result = validateTheme(fixed(), { surfaces: loadSurfaces(SURFACES.pathname) });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.counts.W1).toBe(1);
    expect(result.counts.W2).toBe(5);
    expect(result.counts.W3).toBe(4);
    expect(result.counts.W4).toBe(5);
    expect(result.counts.W5).toBe(1);
  });

  it("still reports 163 -> 61", () => {
    const [finding] = findingsByCode(validateTheme(fixed()), "I1");
    expect(finding?.message).toContain("163 -> 61");
  });

  it("brings the type intersection up to 33", () => {
    expect(typeIntersection(fixed())).toHaveLength(33);
  });
});

describe("name map round-trip", () => {
  it("covers every token in the fixture", () => {
    const entries = theme().names.entries();
    expect(entries.length).toBeGreaterThan(250);
  });

  it("toCanonical(toRaw(x)) === x for every canonical ref", () => {
    for (const entry of theme().names.entries()) {
      expect(toCanonical(toRaw(entry.canonical, entry.category), entry.category)).toBe(entry.canonical);
    }
  });

  it("resolves every raw name back to its canonical ref", () => {
    const t = theme();
    for (const entry of t.names.entries()) {
      expect(t.names.toCanonical(entry.raw, entry.category)).toBe(entry.canonical);
    }
  });

  it("covers every token category", () => {
    const seen = new Set(theme().names.entries().map((e) => e.category));
    expect([...seen].sort()).toEqual([...TOKEN_CATEGORIES].sort());
  });
});
