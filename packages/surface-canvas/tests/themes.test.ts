/**
 * The bundled themes.
 *
 * These tests exist because of a specific failure: an empty theme picker in the
 * panel header, which is what a bundling or schema problem in here looks like
 * from the outside. Asserting the list is non-empty and the values are right
 * catches it at build time instead of in Figma.
 */
import { describe, expect, it } from "vitest";
import { defaultTheme, loadBundledThemes, themeById, themeChoices } from "../src/themes.js";

describe("loadBundledThemes", () => {
  it("bundles at least one theme", () => {
    const themes = loadBundledThemes();
    expect(themes.length).toBeGreaterThan(0);
    for (const { theme, source } of themes) {
      expect(theme.id).toMatch(/[0-9a-f-]{8}/);
      expect(theme.name.length).toBeGreaterThan(0);
      expect(theme.slug).toMatch(/^[a-z0-9-]+$/);
      expect(source).toMatch(/\.json$/);
    }
  });

  it("gives the picker a populated, named list", () => {
    const choices = themeChoices();
    expect(choices.length).toBe(loadBundledThemes().length);
    expect(choices.every((choice) => choice.id && choice.name)).toBe(true);
  });

  it("carries the values the fix queue proposes", () => {
    // If these drift, the four exact batches stop being exact.
    const theme = defaultTheme();
    expect(theme.space.get("2_5")).toBe(10);
    expect(theme.space.get("4")).toBe(16);
    expect(theme.radius.get("none")).toBe(0);
    expect(theme.color.light.get("core_neu_00")).toBe("#ffffff");
  });

  it("resolves a theme by id and caches the parse", () => {
    const first = defaultTheme();
    expect(themeById(first.id)).toBe(first);
    expect(themeById("not-a-theme")).toBeUndefined();
  });
});
