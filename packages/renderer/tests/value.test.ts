import { describe, expect, it } from "vitest";
import { resolveResp, resolveValue } from "../src/resolve/value.js";

describe("resolveValue", () => {
  it("maps token refs to var() — never inlines the px value", () => {
    expect(resolveValue("space.4")).toEqual({
      css: "var(--fos-space-4)",
      raw: false,
      relative: false,
    });
  });

  it("parses negative token refs as calc(-1 * var(...))", () => {
    expect(resolveValue("-space.6")).toEqual({
      css: "calc(-1 * var(--fos-space-6))",
      raw: false,
      relative: false,
    });
  });

  it("emits raw numbers as px and flags raw debt", () => {
    expect(resolveValue({ raw: 28, _unbound: true as const })).toEqual({
      css: "28px",
      raw: true,
      relative: false,
    });
  });

  it("passes percentages through and does NOT mark them raw", () => {
    expect(resolveValue("115%")).toEqual({ css: "115%", raw: false, relative: true });
    expect(resolveValue("32%")).toEqual({ css: "32%", raw: false, relative: true });
  });

  it("maps full/auto to relative keywords", () => {
    expect(resolveValue("full")).toEqual({ css: "100%", raw: false, relative: true });
    expect(resolveValue("auto")).toEqual({ css: "auto", raw: false, relative: true });
  });

  it("maps colour and gradient refs to var()", () => {
    expect(resolveValue("color.text_invert_high").css).toBe("var(--fos-color-text-invert-high)");
    expect(resolveValue("gradient.nue_vert_1").css).toBe("var(--fos-gradient-nue-vert-1)");
  });
});

describe("resolveResp", () => {
  it("lifts a bare value to { base }", () => {
    expect(resolveResp("space.4").values).toEqual({ base: "var(--fos-space-4)" });
  });

  it("emits per-breakpoint values without media queries", () => {
    const { values, rawPaths } = resolveResp({
      base: "space.4",
      md: "space.6",
      lg: { raw: 40, _unbound: true },
    });
    expect(values).toEqual({
      base: "var(--fos-space-4)",
      md: "var(--fos-space-6)",
      lg: "40px",
    });
    expect(rawPaths).toEqual(["lg"]);
  });
});
