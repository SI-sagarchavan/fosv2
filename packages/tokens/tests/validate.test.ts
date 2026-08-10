import { describe, expect, it } from "vitest";
import { errorClasses, findingsByCode, validateTheme } from "../src/validate.js";
import { normalizeTheme } from "../src/normalize.js";
import {
  BACKWARDS_GRADIENT,
  CLEAN_THEME,
  makeSurfaces,
  makeTheme,
  RUN_GRADIENT,
  THREE_LAYER_SURFACES,
} from "./helpers.js";

describe("a clean theme", () => {
  it("passes with no errors", () => {
    const result = validateTheme(makeTheme());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("E1 — type.* breakpoint parity", () => {
  it("names the key and every breakpoint it is missing from", () => {
    const theme = makeTheme({
      typography_desktop: {}, // body_md_regular now exists on mobile + tablet only
    });
    const [finding, ...rest] = findingsByCode(validateTheme(theme), "E1");
    expect(rest).toEqual([]);
    expect(finding?.path).toBe("type.body_md_regular");
    expect(finding?.data).toMatchObject({ present: ["mobile", "tablet"], missing: ["desktop"] });
  });

  it("does not fire when all three breakpoints agree", () => {
    expect(findingsByCode(validateTheme(makeTheme()), "E1")).toEqual([]);
  });
});

describe("E2 — unresolvable surface refs", () => {
  it("rejects a ref that names nothing", () => {
    const result = validateTheme(makeTheme(), {
      surfaces: makeSurfaces({ card: { layers: [{ type: "gradient", ref: "gradient.does_not_exist" }] } }),
    });
    const [finding] = findingsByCode(result, "E2");
    expect(finding?.data).toMatchObject({ ref: "gradient.does_not_exist" });
  });

  it("rejects an asset ref with no entry in the assets map", () => {
    const result = validateTheme(makeTheme(), {
      surfaces: makeSurfaces({ surfaces: { card: { layers: [{ type: "image", ref: "asset.texture.missing" }] } } }),
    });
    expect(findingsByCode(result, "E2")).toHaveLength(1);
  });

  it("accepts a fully-resolving surface", () => {
    const result = validateTheme(makeTheme(), { surfaces: makeSurfaces(THREE_LAYER_SURFACES) });
    expect(result.errors).toEqual([]);
  });

  it("rejects a type ref that is missing on some breakpoint", () => {
    // Resolving on two viewports and 404-ing on the third is exactly the failure
    // E1 exists to prevent, so a surface may not reference such a style either.
    const theme = makeTheme({ typography_desktop: {} });
    const result = validateTheme(theme, {
      surfaces: makeSurfaces({ card: { radius: "type.body_md_regular" } }),
    });
    expect(findingsByCode(result, "E2")).toHaveLength(1);
  });
});

describe("E3 — inset borders", () => {
  it("allows exactly one", () => {
    const result = validateTheme(makeTheme(), { surfaces: makeSurfaces(THREE_LAYER_SURFACES) });
    expect(findingsByCode(result, "E3")).toEqual([]);
  });

  it("rejects two, naming both indexes", () => {
    const result = validateTheme(makeTheme(), {
      surfaces: makeSurfaces({
        card: {
          borders: [
            { width: 1, color: "color.core_neu_00", inset: 4 },
            { width: 1, color: "color.core_neu_00", inset: 8 },
          ],
        },
      }),
    });
    const [finding] = findingsByCode(result, "E3");
    expect(finding?.data).toMatchObject({ indexes: [0, 1] });
  });
});

describe("E4 — gradient stop ordering", () => {
  it("rejects stops that move backwards (0, 60, 30)", () => {
    const result = validateTheme(normalizeTheme("t", BACKWARDS_GRADIENT));
    const [finding] = findingsByCode(result, "E4");
    expect(finding?.data).toMatchObject({ percents: [0, 60, 30], decreasingAt: [2] });
  });

  it("tolerates repeated percents, which are hard stops rather than an error", () => {
    expect(findingsByCode(validateTheme(normalizeTheme("t", RUN_GRADIENT)), "E4")).toEqual([]);
  });

  it("rejects a percent outside 0-100", () => {
    const theme = normalizeTheme("t", {
      ...CLEAN_THEME,
      gradient: {
        light: {
          gradient_sec_vert_1_gradient: {
            type: "linear-gradient",
            degree: 180,
            stops: [
              { color: "#000000", opacity: 100, percent: 0 },
              { color: "#000000", opacity: 100, percent: 140 },
            ],
          },
        },
      },
    });
    expect(findingsByCode(validateTheme(theme), "E4")).toHaveLength(1);
  });
});

describe("E5 — malformed and out-of-range values", () => {
  it("rejects a malformed hex", () => {
    const theme = makeTheme({ color: { light: { core_neu_00: "#ffff", core_sec_500: "#2939a3" } } });
    expect(findingsByCode(validateTheme(theme), "E5")).toHaveLength(1);
  });

  it("rejects negative spacing", () => {
    const theme = makeTheme({ spacing: { spacing_0: 0, "spacing_-1": -4 } });
    const [finding] = findingsByCode(validateTheme(theme), "E5");
    expect(finding?.data).toMatchObject({ value: -4 });
  });

  it("rejects opacity outside 0-100", () => {
    const theme = makeTheme({ opacity: { opacity_0: 0, opacity_120: 120 } });
    expect(findingsByCode(validateTheme(theme), "E5")).toHaveLength(1);
  });
});

describe("E6 — core scale collision", () => {
  it("fires when two steps of one family share a value", () => {
    const theme = makeTheme({
      color: { light: { core_sec_500: "#2939a3", core_sec_600: "#2939a3", core_neu_00: "#ffffff" } },
    });
    const [finding, ...rest] = findingsByCode(validateTheme(theme), "E6");
    expect(rest).toEqual([]);
    expect(finding?.data).toMatchObject({ family: "sec", value: "#2939a3", names: ["core_sec_500", "core_sec_600"] });
  });

  it("ignores an alias that crosses families — that is what a semantic layer is for", () => {
    const theme = makeTheme({
      color: { light: { core_neu_00: "#ffffff", text_invert_high: "#ffffff", core_sec_500: "#2939a3" } },
    });
    expect(findingsByCode(validateTheme(theme), "E6")).toEqual([]);
  });
});

describe("E7 — canonical ref collision", () => {
  it("fires when two raw names reduce to one canonical ref", () => {
    // `drop_shadow_md` and `inner_shadow_md` both normalize to `shadow.md`.
    const theme = makeTheme({
      shadow: {
        light: {
          drop_shadow_md: { x: 1, y: 1, blur: 1, spread: 0, color: "#000000", opacity: 40, type: "drop" },
          inner_shadow_md: { x: 1, y: 1, blur: 1, spread: 0, color: "#000000", opacity: 40, type: "inner" },
        },
      },
    });
    const [finding] = findingsByCode(validateTheme(theme), "E7");
    expect(finding?.data).toMatchObject({ canonical: "shadow.md" });
  });
});

describe("W1 — near-duplicate names", () => {
  it("collapses separators to find a name authored twice", () => {
    const theme = makeTheme({
      color: { light: { background_sec_card2: "#5c6cd6", background_sec_card_2: "#5c6cd6", core_neu_00: "#fff000" } },
    });
    const [finding] = findingsByCode(validateTheme(theme), "W1");
    expect(finding?.data).toMatchObject({ names: ["background_sec_card2", "background_sec_card_2"] });
  });

  it("does NOT fuse half-step spacing into its whole-number neighbour", () => {
    // `1_5` and `15` are different real tokens; collapsing the underscore
    // between two digits would report a duplicate that does not exist.
    const theme = makeTheme({ spacing: { spacing_1_5: 6, spacing_15: 98 } });
    expect(findingsByCode(validateTheme(theme), "W1")).toEqual([]);
  });
});

describe("W2 — opaque shadows", () => {
  it("flags a shadow at 100% opacity", () => {
    const theme = makeTheme({
      shadow: {
        light: {
          drop_shadow_md: { x: "3px", y: "3px", blur: "4px", spread: "0px", color: "#1a1a1a", opacity: 100, type: "drop" },
        },
      },
    });
    const [finding] = findingsByCode(validateTheme(theme), "W2");
    expect(finding?.path).toBe("shadow.light.drop_shadow_md");
  });

  it("stays quiet below 100", () => {
    expect(findingsByCode(validateTheme(makeTheme()), "W2")).toEqual([]);
  });
});

describe("W3 — weight vs name suffix", () => {
  it("flags a medium style that is actually bold", () => {
    const theme = makeTheme({
      typography_mobile: { xl_medium: { size: 20, weight: 700, typeface: "Montserrat", line_height: 24, letter_spacing: 0 } },
      typography_tablet: { xl_medium: { size: 20, weight: 500, typeface: "Montserrat", line_height: 24, letter_spacing: 0 } },
      typography_desktop: { xl_medium: { size: 20, weight: 500, typeface: "Montserrat", line_height: 24, letter_spacing: 0 } },
    });
    const findings = findingsByCode(validateTheme(theme), "W3");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data).toMatchObject({ breakpoint: "mobile", weight: 700, expected: 500 });
  });

  it("ignores suffixes it has no opinion about", () => {
    const theme = makeTheme({
      typography_mobile: { dp_1_black: { size: 20, weight: 900, typeface: "M", line_height: 24, letter_spacing: 0 } },
      typography_tablet: { dp_1_black: { size: 20, weight: 900, typeface: "M", line_height: 24, letter_spacing: 0 } },
      typography_desktop: { dp_1_black: { size: 20, weight: 900, typeface: "M", line_height: 24, letter_spacing: 0 } },
    });
    expect(findingsByCode(validateTheme(theme), "W3")).toEqual([]);
  });
});

describe("W4 — empty categories", () => {
  it("reports each empty section once", () => {
    const theme = makeTheme({ badge: { size: {} }, button: { size: {} }, color: { light: { a: "#000000" }, dark: {} } });
    const paths = findingsByCode(validateTheme(theme), "W4").map((f) => f.path);
    expect(paths).toEqual(["badge.size", "button.size", "color.dark"]);
  });
});

describe("W5 — letter_spacing", () => {
  it("aggregates into one finding rather than one per style", () => {
    const findings = findingsByCode(validateTheme(makeTheme()), "W5");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data).toMatchObject({ total: 3 });
  });

  it("stays quiet when any style has real tracking", () => {
    const theme = makeTheme({
      typography_mobile: { a: { size: 16, weight: 400, typeface: "M", line_height: 20, letter_spacing: 0.02 } },
      typography_tablet: { a: { size: 16, weight: 400, typeface: "M", line_height: 20, letter_spacing: 0 } },
      typography_desktop: { a: { size: 16, weight: 400, typeface: "M", line_height: 20, letter_spacing: 0 } },
    });
    expect(findingsByCode(validateTheme(theme), "W5")).toEqual([]);
  });
});

describe("W6 — collapsed gradient stops", () => {
  it("fires on a run of 3+ stops at the same percent", () => {
    const findings = findingsByCode(validateTheme(normalizeTheme("t", RUN_GRADIENT)), "W6");
    expect(findings).toHaveLength(2);
    expect(findings[0]?.data).toMatchObject({ percent: 100, length: 4 });
  });

  it("stays quiet on a run of two", () => {
    const theme = normalizeTheme("t", {
      ...CLEAN_THEME,
      gradient: {
        light: {
          gradient_sec_vert_1_gradient: {
            type: "linear-gradient",
            degree: 180,
            stops: [
              { color: "#000000", opacity: 0, percent: 0 },
              { color: "#000000", opacity: 50, percent: 100 },
              { color: "#000000", opacity: 100, percent: 100 },
            ],
          },
        },
      },
    });
    expect(findingsByCode(validateTheme(theme), "W6")).toEqual([]);
  });
});

describe("I1 — alias density", () => {
  it("reports the ratio once, not once per alias", () => {
    const theme = makeTheme({
      color: { light: { a: "#ffffff", b: "#ffffff", c: "#ffffff", d: "#000000" } },
    });
    const findings = findingsByCode(validateTheme(theme), "I1");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data).toMatchObject({ names: 4, distinct: 2 });
    expect(findings[0]?.severity).toBe("info");
  });
});

describe("result shape", () => {
  it("is deterministically ordered", () => {
    const theme = makeTheme({ typography_desktop: {}, opacity: { opacity_120: 120 } });
    const a = validateTheme(theme).findings.map((f) => `${f.code} ${f.path}`);
    const b = validateTheme(theme).findings.map((f) => `${f.code} ${f.path}`);
    expect(a).toEqual(b);
    // Errors first, then warnings, then info.
    const severities = validateTheme(theme).findings.map((f) => f.severity);
    expect(severities).toEqual([...severities].sort((x, y) => (x === y ? 0 : x === "error" ? -1 : y === "error" ? 1 : x === "warning" ? -1 : 1)));
  });

  it("counts error CLASSES, not individual errors", () => {
    const theme = makeTheme({
      typography_desktop: {},
      color: { light: { core_sec_500: "#2939a3", core_sec_600: "#2939a3" } },
    });
    expect(errorClasses(validateTheme(theme))).toEqual(["E1", "E6"]);
  });
});
