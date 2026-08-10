import { describe, expect, it } from "vitest";
import { detectTailwindMajor, emitTailwindV3, emitTailwindV4 } from "../src/emit/tailwind.js";
import { loadTheme } from "../src/load.js";

const FIXTURE = new URL("../fixtures/southern-brave.json", import.meta.url).pathname;

function theme() {
  return loadTheme(FIXTURE);
}

describe("v4 @theme block", () => {
  const css = () => emitTailwindV4(theme());

  it("maps our vocabulary onto Tailwind's namespaces", () => {
    const out = css();
    expect(out).toContain("@theme {");
    expect(out).toContain("--color-core-sec-500: var(--fos-color-core-sec-500);");
    expect(out).toContain("--spacing-4: var(--fos-space-4);");
    expect(out).toContain("--radius-2xl: var(--fos-radius-2xl);");
    expect(out).toContain("--shadow-md: var(--fos-shadow-md);");
  });

  it("carries leading, weight and tracking with the text scale", () => {
    const out = css();
    expect(out).toContain("--text-dp_2_regular: var(--fos-type-dp-2-regular-size);");
    expect(out).toContain("--text-dp_2_regular--line-height: var(--fos-type-dp-2-regular-leading);");
    expect(out).toContain("--text-dp_2_regular--font-weight: var(--fos-type-dp-2-regular-weight);");
    expect(out).toContain("--text-dp_2_regular--letter-spacing: var(--fos-type-dp-2-regular-tracking);");
  });

  it("REFERENCES our vars and never duplicates a value", () => {
    // A copied literal is a second source of truth that rots the first time
    // someone edits the theme and rebuilds only the CSS.
    const out = css();
    expect(out).not.toContain("#2939a3");
    expect(out).not.toContain("--spacing-4: 16px");
    expect(out).not.toContain("--radius-2xl: 24px");
  });

  it("emits breakpoints", () => {
    expect(css()).toContain("--breakpoint-md: 768px;");
    expect(css()).toContain("--breakpoint-lg: 1280px;");
  });

  it("exposes gradients under a custom namespace, since Tailwind has none", () => {
    expect(css()).toContain("--gradient-nue-vert-1: var(--fos-gradient-nue-vert-1);");
  });

  it("is byte-identical across two runs", () => {
    expect(css()).toBe(css());
  });
});

describe("v3 preset", () => {
  const js = () => emitTailwindV3(theme());

  it("emits a module with the expected shape", () => {
    const out = js();
    expect(out).toContain("module.exports = {");
    expect(out).toContain('"4": "var(--fos-space-4)"');
    expect(out).toContain('"2xl": "var(--fos-radius-2xl)"');
  });

  it("uses <alpha-value> so bg-core-sec-500/20 works", () => {
    expect(js()).toContain('"core-sec-500": "rgb(var(--fos-color-core-sec-500-rgb) / <alpha-value>)"');
  });

  it("is byte-identical across two runs", () => {
    expect(js()).toBe(js());
  });
});

describe("detectTailwindMajor", () => {
  it("reads the major from any dependency field", () => {
    expect(detectTailwindMajor({ dependencies: { tailwindcss: "^4.0.1" } })).toBe(4);
    expect(detectTailwindMajor({ devDependencies: { tailwindcss: "3.4.0" } })).toBe(3);
    expect(detectTailwindMajor({ peerDependencies: { tailwindcss: "~4.1" } })).toBe(4);
  });

  it("returns undefined when Tailwind is absent or the range is not semver", () => {
    expect(detectTailwindMajor({ dependencies: {} })).toBeUndefined();
    expect(detectTailwindMajor({ dependencies: { tailwindcss: "latest" } })).toBeUndefined();
    expect(detectTailwindMajor(null)).toBeUndefined();
  });
});
