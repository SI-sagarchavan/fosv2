import { describe, expect, it } from "vitest";
import { createRegistry, SEARCH_LIMIT } from "../src/registry.js";
import { loadSurfaces, loadTheme } from "../src/load.js";

const FIXTURE = new URL("../fixtures/southern-brave.json", import.meta.url).pathname;
const SURFACES = new URL("../surfaces/southern-brave.json", import.meta.url).pathname;

function registry() {
  return createRegistry(loadTheme(FIXTURE), { surfaces: loadSurfaces(SURFACES) });
}

describe("has / resolve", () => {
  it("accepts real refs and rejects invented ones", () => {
    const r = registry();
    expect(r.has("color.core_sec_500")).toBe(true);
    expect(r.has("space.0_5")).toBe(true);
    expect(r.has("surface.card_player")).toBe(true);
    expect(r.has("asset.texture.noise")).toBe(true);
    expect(r.has("color.core_sec_999")).toBe(false);
    expect(r.has("nonsense")).toBe(false);
  });

  it("refuses a type ref that is missing on some breakpoint", () => {
    const r = registry();
    expect(r.has("type.h1_bold")).toBe(true);
    expect(r.has("type.xl_medium")).toBe(false);
  });

  it("resolves to a discriminated value", () => {
    const r = registry();
    expect(r.resolve("space.4")).toEqual({ category: "space", px: 16 });
    expect(r.resolve("color.core_sec_500")).toEqual({ category: "color", hex: "#2939a3", rgb: [41, 57, 163] });
    expect(r.resolve("opacity.40")).toEqual({ category: "opacity", percent: 40, unit: 0.4 });
    expect(r.resolve("color.nope")).toBeUndefined();
  });
});

describe("list", () => {
  it("returns sorted, fully-qualified refs", () => {
    const r = registry();
    expect(r.list("space").slice(0, 3)).toEqual(["space.0", "space.0_5", "space.1"]);
    expect(r.list("color")).toHaveLength(163);
    expect(r.list("type")).toHaveLength(30);
    // Derived from the surfaces file — adding a surface is a design change and
    // must not break a test about sorting and qualification.
    const expectedSurfaces = [...loadSurfaces(SURFACES).surfaces.keys()]
      .sort()
      .map((k) => `surface.${k}`);
    expect(r.list("surface")).toEqual(expectedSurfaces);
  });
});

describe("search", () => {
  it("finds a colour by its bare step, ignoring punctuation", () => {
    const r = registry();
    for (const query of ["core_sec_500", "core-sec-500", "coresec500"]) {
      expect(r.search(query)[0]).toBe("color.core_sec_500");
    }
  });

  it("ranks an exact ref first", () => {
    expect(registry().search("space.4")[0]).toBe("space.4");
  });

  it("caps results so an agent's context stays small", () => {
    const results = registry().search("core");
    expect(results.length).toBeLessThanOrEqual(SEARCH_LIMIT);
    expect(results.length).toBe(SEARCH_LIMIT);
  });

  it("returns nothing for an empty query rather than the whole catalogue", () => {
    expect(registry().search("   ")).toEqual([]);
  });

  it("is deterministic", () => {
    expect(registry().search("sec")).toEqual(registry().search("sec"));
  });
});

describe("cssVar / describe", () => {
  it("gives the var reference a consumer can paste", () => {
    expect(registry().cssVar("space.4")).toBe("var(--fos-space-4)");
    expect(registry().cssVar("space.0_5")).toBe("var(--fos-space-0_5)");
  });

  it("describes a token compactly, including its designer-facing raw name", () => {
    expect(registry().describe("shadow.md")).toEqual({
      ref: "shadow.md",
      category: "shadow",
      raw: "drop_shadow_md",
      value: "3 3 4 0 #1a1a1a@100%",
      cssVar: "var(--fos-shadow-md)",
    });
  });

  it("describes a colour with both forms", () => {
    expect(registry().describe("color.core_sec_500")).toMatchObject({
      raw: "core_sec_500",
      value: "#2939a3 (rgb 41 57 163)",
      cssVar: "var(--fos-color-core-sec-500)",
    });
  });

  it("describes a type token across breakpoints in one line", () => {
    const described = registry().describe("type.h1_bold");
    expect(described?.value).toMatch(/^mobile .+; tablet .+; desktop .+$/);
  });

  it("describes a surface by shape rather than dumping it", () => {
    // Counts come from the surfaces file, not a literal — layer composition is a
    // design value that changes, and this test is about `describe` SUMMARISING
    // rather than dumping the whole surface.
    const surfaces = loadSurfaces(SURFACES);
    const card = surfaces.surfaces.get("card_player")!;
    const described = registry().describe("surface.card_player");
    expect(described).toMatchObject({ category: "surface" });
    // Built the same way describe() builds it, so a surface that drops its
    // borders/radius/shadow (card_player now leans on its background asset for
    // all three) does not break a test about summarising.
    const expected = [
      `${(card.layers ?? []).length} layers`,
      `${(card.borders ?? []).length} borders`,
      ...(card.radius ? [card.radius] : []),
      ...(card.shadow ? [card.shadow] : []),
    ].join(", ");
    expect(described!.value).toBe(expected);
    // Compact enough for an agent's context.
    expect(described!.value.length).toBeLessThan(80);
  });

  it("returns undefined for an unknown ref", () => {
    expect(registry().describe("color.nope")).toBeUndefined();
  });
});
