import { describe, expect, it } from "vitest";
import {
  compareTokenNames,
  parseLength,
  slugify,
  stripCategoryPrefix,
  toCanonical,
  toRaw,
} from "../src/normalize.js";
import { cssClassName, cssRgbVarName, cssVarName, dashify } from "../src/refs.js";
import { makeTheme } from "./helpers.js";

describe("toCanonical — the naming contract", () => {
  // These nine pairs ARE the contract. The Figma IR extractor, the CSS emitter
  // and the generated types all depend on them agreeing exactly.
  const CONTRACT: Array<[string, string]> = [
    ["spacing.spacing_4", "space.4"],
    ["spacing.spacing_0_5", "space.0_5"],
    ["radius.radius_2xl", "radius.2xl"],
    ["radius.radius_rounded", "radius.rounded"],
    ["color.light.core_sec_500", "color.core_sec_500"],
    ["color.light.text_invert_high", "color.text_invert_high"],
    ["gradient.light.gradient_nue_vert_1_gradient", "gradient.nue_vert_1"],
    ["shadow.light.drop_shadow_md", "shadow.md"],
    ["opacity.opacity_40", "opacity.40"],
    ["typography_desktop.dp_2_regular", "type.dp_2_regular"],
  ];

  for (const [raw, canonical] of CONTRACT) {
    it(`${raw} -> ${canonical}`, () => {
      expect(toCanonical(raw)).toBe(canonical);
    });
  }

  it("accepts Figma's slash-separated paths, which is what boundVariables yields", () => {
    expect(toCanonical("color/light/core_sec_500")).toBe("color.core_sec_500");
    expect(toCanonical("gradient/light/gradient_nue_vert_1_gradient")).toBe("gradient.nue_vert_1");
  });

  it("takes an explicit category for a bare leaf", () => {
    expect(toCanonical("core_sec_500", "color")).toBe("color.core_sec_500");
    expect(toCanonical("dp_2_regular", "type")).toBe("type.dp_2_regular");
  });

  it("infers the category from a leaf that carries its own prefix", () => {
    expect(toCanonical("spacing_4")).toBe("space.4");
    expect(toCanonical("drop_shadow_md")).toBe("shadow.md");
  });

  it("throws rather than guessing when the category is unknowable", () => {
    // A bare colour name and a bare type key are indistinguishable. Guessing
    // would produce a plausible, wrong ref — worse than a loud failure.
    expect(() => toCanonical("core_sec_500")).toThrow(/cannot infer category/);
  });

  it("is idempotent on an already-canonical ref", () => {
    expect(toCanonical("color.core_sec_500")).toBe("color.core_sec_500");
    expect(toCanonical("space.0_5")).toBe("space.0_5");
  });

  it("never consumes the category word when it is the last segment", () => {
    expect(stripCategoryPrefix("foo_shadow", "shadow")).toBe("foo_shadow");
  });
});

describe("toRaw", () => {
  it("inverts each category's raw pattern", () => {
    expect(toRaw("space.4")).toBe("spacing_4");
    expect(toRaw("space.0_5")).toBe("spacing_0_5");
    expect(toRaw("radius.2xl")).toBe("radius_2xl");
    expect(toRaw("opacity.40")).toBe("opacity_40");
    expect(toRaw("gradient.nue_vert_1")).toBe("gradient_nue_vert_1_gradient");
    expect(toRaw("shadow.md")).toBe("drop_shadow_md");
    expect(toRaw("color.core_sec_500")).toBe("core_sec_500");
    expect(toRaw("type.dp_2_regular")).toBe("dp_2_regular");
  });

  it("round-trips through toCanonical", () => {
    for (const ref of ["space.4", "radius.2xl", "opacity.40", "gradient.nue_vert_1", "shadow.md"]) {
      expect(toCanonical(toRaw(ref))).toBe(ref);
    }
  });
});

describe("name map", () => {
  it("resolves both directions against real data", () => {
    const theme = makeTheme();
    expect(theme.names.toCanonical("drop_shadow_md")).toBe("shadow.md");
    expect(theme.names.toCanonical("gradient_sec_vert_1_gradient")).toBe("gradient.sec_vert_1");
    expect(theme.names.toRaw("shadow.md")).toBe("drop_shadow_md");
    expect(theme.names.toRaw("gradient.sec_vert_1")).toBe("gradient_sec_vert_1_gradient");
  });

  it("disambiguates a leaf shared by two categories with an explicit category", () => {
    // `core_sec_500` exists only as a colour here, but the qualified lookup is
    // the path the extractor uses and has to work regardless.
    const theme = makeTheme();
    expect(theme.names.toCanonical("core_sec_500", "color")).toBe("color.core_sec_500");
  });

  it("reports no collisions on a well-formed theme", () => {
    expect(makeTheme().names.collisions()).toEqual([]);
  });
});

describe("compareTokenNames", () => {
  it("orders the space scale numerically, half-steps included", () => {
    const keys = ["10", "0_5", "2", "1", "16", "0", "1_5", "3_5"];
    expect([...keys].sort(compareTokenNames)).toEqual(["0", "0_5", "1", "1_5", "2", "3_5", "10", "16"]);
  });

  it("is a total order and locale-independent", () => {
    // localeCompare would make this depend on the ICU build, which would break
    // the byte-determinism guarantee on emitted CSS.
    const keys = ["2xl", "lg", "md", "none", "rounded", "sm", "xl", "xs"];
    expect([...keys].reverse().sort(compareTokenNames)).toEqual([...keys].sort(compareTokenNames));
    expect(compareTokenNames("a", "a")).toBe(0);
  });
});

describe("CSS naming", () => {
  it("dashes underscores except between two digits", () => {
    expect(dashify("core_sec_500")).toBe("core-sec-500");
    expect(dashify("0_5")).toBe("0_5");
    expect(dashify("dp_2_regular")).toBe("dp-2-regular");
  });

  it("keeps half-step spacing keys underscored so they cannot collide", () => {
    // `--fos-space-0-5` would be ambiguous with a hypothetical `space.0.5`.
    expect(cssVarName("space.0_5")).toBe("--fos-space-0_5");
    expect(cssVarName("space.1_5")).toBe("--fos-space-1_5");
    expect(cssVarName("space.4")).toBe("--fos-space-4");
  });

  it("matches the specced var names", () => {
    expect(cssVarName("radius.2xl")).toBe("--fos-radius-2xl");
    expect(cssVarName("color.core_sec_500")).toBe("--fos-color-core-sec-500");
    expect(cssRgbVarName("color.core_sec_500")).toBe("--fos-color-core-sec-500-rgb");
    expect(cssVarName("gradient.nue_vert_1")).toBe("--fos-gradient-nue-vert-1");
    expect(cssVarName("opacity.40")).toBe("--fos-opacity-40");
  });

  it("keeps class names verbatim — authors type these by hand", () => {
    expect(cssClassName("type", "dp_2_regular")).toBe("fos-type-dp_2_regular");
    expect(cssClassName("surface", "card_player")).toBe("fos-surface-card_player");
  });
});

describe("value coercion", () => {
  it("parses px strings and bare numbers", () => {
    expect(parseLength("3px")).toBe(3);
    expect(parseLength(0)).toBe(0);
    expect(parseLength("-2px")).toBe(-2);
    expect(parseLength("auto")).toBeUndefined();
  });

  it("slugifies a theme name for [data-fos-theme]", () => {
    expect(slugify("Style Southern Brave")).toBe("style-southern-brave");
  });
});
