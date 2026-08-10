import { describe, expect, it } from "vitest";
import { emitCss, formatGradient, formatShadow } from "../src/emit/css.js";
import { coalesceStops } from "../src/gradient.js";
import { normalizeTheme } from "../src/normalize.js";
import { loadSurfaces, loadTheme } from "../src/load.js";
import { BACKWARDS_GRADIENT, makeSurfaces, makeTheme, RUN_GRADIENT, THREE_LAYER_SURFACES } from "./helpers.js";

const FIXTURE = new URL("../fixtures/southern-brave.json", import.meta.url).pathname;
const SURFACES = new URL("../surfaces/southern-brave.json", import.meta.url).pathname;

function realCss() {
  return emitCss(loadTheme(FIXTURE), { surfaces: loadSurfaces(SURFACES) }).css;
}

/** The declaration for one custom property, trimmed. */
function decl(css: string, name: string): string | undefined {
  const line = css.split("\n").find((l) => l.trim().startsWith(`${name}:`));
  return line?.trim();
}

describe("scale vars", () => {
  it("matches the specced output exactly", () => {
    const css = realCss();
    expect(decl(css, "--fos-space-4")).toBe("--fos-space-4: 16px;");
    expect(decl(css, "--fos-radius-2xl")).toBe("--fos-radius-2xl: 24px;");
    expect(decl(css, "--fos-radius-rounded")).toBe("--fos-radius-rounded: 999px;");
    expect(decl(css, "--fos-color-core-sec-500")).toBe("--fos-color-core-sec-500: #2939a3;");
    expect(decl(css, "--fos-opacity-40")).toBe("--fos-opacity-40: 0.4;");
    expect(decl(css, "--fos-shadow-md")).toBe("--fos-shadow-md: 3px 3px 4px 0px rgb(26 26 26 / 100%);");
  });

  it("keeps the half-step underscore, so space-0_5 cannot collide with space-0-5", () => {
    expect(decl(realCss(), "--fos-space-0_5")).toBe("--fos-space-0_5: 2px;");
  });

  it("emits the -rgb triplet for EVERY colour", () => {
    // Not optional: the token file has no alpha variants, so every surface that
    // composites depends on the triplet existing for the colour it references.
    const theme = loadTheme(FIXTURE);
    const css = realCss();
    for (const leaf of theme.color.light.keys()) {
      const base = `--fos-color-${leaf.replace(/_/g, "-")}`;
      expect(decl(css, base), `${base} missing`).toBeDefined();
      expect(decl(css, `${base}-rgb`), `${base}-rgb missing`).toBeDefined();
    }
    expect(decl(css, "--fos-color-core-sec-500-rgb")).toBe("--fos-color-core-sec-500-rgb: 41 57 163;");
  });

  it("emits breakpoints as vars, since the token file has none", () => {
    const css = realCss();
    expect(decl(css, "--fos-bp-md")).toBe("--fos-bp-md: 768px;");
    expect(decl(css, "--fos-bp-lg")).toBe("--fos-bp-lg: 1280px;");
  });
});

describe("gradients", () => {
  it("passes Figma's degree through unchanged — 180 is top-to-bottom in both systems", () => {
    // gradient_nue_vert_1 is authored transparent at 20% and opaque at 100% at
    // degree 180, and renders top-transparent / bottom-dark in Figma. CSS
    // linear-gradient(180deg, …) does the same, so no conversion is applied.
    expect(decl(realCss(), "--fos-gradient-nue-vert-1")).toBe(
      "--fos-gradient-nue-vert-1: linear-gradient(180deg, rgb(26 26 26 / 0%) 20%, rgb(26 26 26 / 100%) 100%);",
    );
  });

  it("coalesces a run of 3+ stops to the run's first and last", () => {
    // The fanxp-web-renderer shape: percents 20,100,100,100,100 carrying
    // opacities 0,100,25,25,25. The run's first and last differ, so both survive.
    const theme = normalizeTheme("t", RUN_GRADIENT);
    const stops = coalesceStops(theme.gradient.light.get("nue_vert_1")!.stops);
    expect(stops.map((s) => s.percent)).toEqual([20, 100, 100]);
    expect(stops.map((s) => s.opacity)).toEqual([0, 100, 25]);

    // When the members of the run are identical, it collapses to two stops.
    const identical = coalesceStops(theme.gradient.light.get("nue_vert_2")!.stops);
    expect(identical.map((s) => s.percent)).toEqual([20, 100]);
  });

  it("leaves a well-formed gradient untouched", () => {
    const theme = makeTheme();
    expect(formatGradient(theme.gradient.light.get("sec_vert_1")!)).toBe(
      "linear-gradient(180deg, rgb(26 26 26 / 0%) 0%, rgb(26 26 26 / 100%) 100%)",
    );
  });

  it("still emits a gradient whose stops move backwards — the validator is what rejects it", () => {
    const theme = normalizeTheme("t", BACKWARDS_GRADIENT);
    expect(formatGradient(theme.gradient.light.get("sec_vert_1")!)).toContain("0%, ");
  });
});

describe("shadows", () => {
  it("emits `inset` for an inner shadow and nothing for a drop shadow", () => {
    const inner = makeTheme({
      shadow: {
        light: {
          inner_shadow_md: { x: 1, y: 2, blur: 3, spread: 0, color: "#000000", opacity: 50, type: "inner" },
        },
      },
    });
    expect(formatShadow(inner.shadow.light.get("md")!)).toBe("inset 1px 2px 3px 0px rgb(0 0 0 / 50%)");
    expect(formatShadow(makeTheme().shadow.light.get("md")!)).toBe("3px 3px 4px 0px rgb(26 26 26 / 40%)");
  });
});

describe("typography", () => {
  it("emits five vars per style plus a utility class", () => {
    const css = realCss();
    expect(decl(css, "--fos-type-dp-2-regular-size")).toBe("--fos-type-dp-2-regular-size: 36px;");
    expect(decl(css, "--fos-type-dp-2-regular-weight")).toBe("--fos-type-dp-2-regular-weight: 400;");
    expect(decl(css, "--fos-type-dp-2-regular-family")).toBe('--fos-type-dp-2-regular-family: "Bakbak One";');
    expect(decl(css, "--fos-type-dp-2-regular-leading")).toBe("--fos-type-dp-2-regular-leading: 40px;");
    expect(decl(css, "--fos-type-dp-2-regular-tracking")).toBe("--fos-type-dp-2-regular-tracking: 0em;");
    expect(css).toContain(".fos-type-dp_2_regular {");
  });

  it("is mobile-first: :root carries mobile, media queries carry the rest", () => {
    const css = realCss();
    const root = css.slice(0, css.indexOf("@media"));
    expect(root).toContain("--fos-type-dp-2-regular-size: 36px;");
    expect(css).toContain("@media (min-width: 768px) {");
    expect(css).toContain("@media (min-width: 1280px) {");
    expect(css.indexOf("@media (min-width: 768px)")).toBeLessThan(css.indexOf("@media (min-width: 1280px)"));
  });

  it("emits only the 30 breakpoint-complete styles by default", () => {
    const css = realCss();
    expect(css).not.toContain("--fos-type-xl-medium-size");
    expect(css).not.toContain("--fos-type-h3-medium-size");
    const classes = css.match(/\.fos-type-[a-z0-9_]+ \{/g) ?? [];
    expect(classes).toHaveLength(30);
  });

  it("with --allow-partial-typography, falls back and warns", () => {
    const result = emitCss(loadTheme(FIXTURE), { allowPartialTypography: true });
    expect(result.css).toContain("--fos-type-xl-medium-size");
    expect(result.css).toContain("--fos-type-h3-medium-size");
    const classes = result.css.match(/\.fos-type-[a-z0-9_]+ \{/g) ?? [];
    expect(classes).toHaveLength(33);
    // xl_* is missing on desktop and falls back to tablet; h3_medium is
    // desktop-only and has nothing smaller, so it reaches upward instead.
    expect(result.warnings).toContain("type.xl_medium is not defined for desktop; falling back to tablet (--allow-partial-typography)");
    expect(result.warnings).toContain("type.h3_medium is not defined for mobile; falling back to desktop (--allow-partial-typography)");
  });

  it("only re-declares vars that actually change at a breakpoint", () => {
    // The cascade carries the rest. Re-emitting all five fields for all 30
    // styles at every breakpoint would triple the file for no effect.
    const css = realCss();
    const tablet = css.slice(css.indexOf("@media (min-width: 768px)"), css.indexOf("@media (min-width: 1280px)"));
    expect(tablet).not.toContain("-family:");
  });
});

describe("surfaces", () => {
  it("REVERSES the authored layer order, because background-image paints first-on-top", () => {
    // Authored bottom-to-top: gradient, stripes, noise.
    // Emitted must be noise, stripes, gradient — get this wrong and every
    // textured surface renders inside-out.
    const { css } = emitCss(makeTheme(), { surfaces: makeSurfaces(THREE_LAYER_SURFACES) });
    const line = css.split("\n").find((l) => l.includes("background-image:"))!;
    expect(line.trim()).toBe(
      'background-image: url("/noise.png"), url("/stripes.png"), var(--fos-gradient-sec-vert-1);',
    );
    expect(line.indexOf("noise")).toBeLessThan(line.indexOf("stripes"));
    expect(line.indexOf("stripes")).toBeLessThan(line.indexOf("gradient"));
  });

  it("reverses the blend modes with them", () => {
    const { css } = emitCss(makeTheme(), { surfaces: makeSurfaces(THREE_LAYER_SURFACES) });
    expect(css).toContain("background-blend-mode: overlay, overlay, normal;");
  });

  it("renders the inset border as ::before with inset: 8px", () => {
    const { css } = emitCss(makeTheme(), { surfaces: makeSurfaces(THREE_LAYER_SURFACES) });
    const before = css.slice(css.indexOf(".fos-surface-card_player::before"));
    expect(before).toContain("content: \"\";");
    expect(before).toContain("position: absolute;");
    expect(before).toContain("inset: 8px;");
    expect(before).toContain("pointer-events: none;");
    expect(before).toContain("border: 1px solid rgb(var(--fos-color-core-neu-00-rgb) / 10%);");
    expect(before).toContain("border-radius: var(--fos-radius-xl);");
  });

  it("emits the flat border, radius and shadow on the base rule", () => {
    const { css } = emitCss(makeTheme(), { surfaces: makeSurfaces(THREE_LAYER_SURFACES) });
    const base = css.slice(css.indexOf(".fos-surface-card_player {"), css.indexOf(".fos-surface-card_player::before"));
    expect(base).toContain("position: relative;");
    expect(base).toContain("border-radius: var(--fos-radius-2xl);");
    expect(base).toContain("border: 1px solid rgb(var(--fos-color-core-neu-00-rgb) / 20%);");
    expect(base).toContain("box-shadow: var(--fos-shadow-md);");
  });

  it("omits position: relative when nothing needs a containing block", () => {
    const { css } = emitCss(makeTheme(), {
      surfaces: makeSurfaces({ plain: { radius: "radius.xl", shadow: "shadow.md" } }),
    });
    expect(css.slice(css.indexOf(".fos-surface-plain"))).not.toContain("position: relative");
  });

  it("warns that CSS cannot apply opacity to a background-image layer", () => {
    const { warnings } = emitCss(makeTheme(), { surfaces: makeSurfaces(THREE_LAYER_SURFACES) });
    expect(warnings.some((w) => w.includes("asset.texture.stripes") && w.includes("opacity 30"))).toBe(true);
  });

  it("folds alpha directly into colour and gradient layers, where CSS can express it", () => {
    const { css } = emitCss(makeTheme(), {
      surfaces: makeSurfaces({
        tint: { layers: [{ type: "color", ref: "color.core_sec_500", opacity: 8 }] },
      }),
    });
    expect(css).toContain(
      "background-image: linear-gradient(rgb(var(--fos-color-core-sec-500-rgb) / 8%) 0%, rgb(var(--fos-color-core-sec-500-rgb) / 8%) 100%);",
    );
  });
});

describe("theme scoping", () => {
  it("uses :root by default and the data attribute under --scope attr", () => {
    expect(emitCss(loadTheme(FIXTURE)).css).toContain(":root {");
    expect(emitCss(loadTheme(FIXTURE), { scope: "attr" }).css).toContain('[data-fos-theme="style-southern-brave"] {');
  });
});

describe("determinism", () => {
  it("is byte-identical across two runs", () => {
    // The output is content-hashed for cache busting; a byte that moves for no
    // reason costs every user a cache miss.
    expect(realCss()).toBe(realCss());
  });

  it("does not depend on the insertion order of the input", () => {
    const forward = makeTheme({ spacing: { spacing_0: 0, spacing_4: 16, spacing_0_5: 2 } });
    const shuffled = makeTheme({ spacing: { spacing_0_5: 2, spacing_4: 16, spacing_0: 0 } });
    expect(emitCss(forward).css).toBe(emitCss(shuffled).css);
  });

  it("contains no timestamp or other varying content", () => {
    expect(realCss()).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
