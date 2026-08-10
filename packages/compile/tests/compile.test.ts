/**
 * The compiler's contract, in order of importance.
 *
 *   1. determinism — same IR in, byte-identical tree out. Without this a
 *      regenerated fixture cannot be diffed against the last one, and the whole
 *      reason for preferring a compiler to a model evaporates.
 *   2. legality — output always validates. A compiler that emits a broken tree
 *      is worse than a human doing it slowly.
 *   3. the specific mappings that were got wrong by hand, so they stay right.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRegistry, loadSurfaces, loadTheme } from "@fanos/tokens";
import { flatTreeSchema, reify, validate } from "@fanos/dsl";
import { parseFrameIRDocument, type FrameIRDocument } from "@fanos/figma-ir-extractor/ir";
import { compile } from "../src/compile.js";
import { isMeaningful, slug } from "../src/ids.js";
import { canonicalRef, paintRef } from "../src/refs.js";
import { snapSpace } from "../src/props.js";

const irDir = new URL("../../conform/fixtures/ir/", import.meta.url).pathname;
const THEME = new URL("../../tokens/fixtures/southern-brave.json", import.meta.url).pathname;
const SURFACES = new URL("../../tokens/surfaces/southern-brave.json", import.meta.url).pathname;

const theme = loadTheme(THEME);
const surfaces = loadSurfaces(SURFACES);
const ir = (name: string): FrameIRDocument =>
  parseFrameIRDocument(JSON.parse(readFileSync(`${irDir}${name}.ir.json`, "utf8")));

const FIXTURES = [
  "newsletter-signup",
  "news-card",
  "videos-section",
  "fixture-card",
  "player-card",
] as const;

/** Validate against the theme's surfaces plus the ones this compile requires. */
function check(name: string) {
  const result = compile(ir(name), { theme, surfaces });
  const merged = {
    assets: surfaces.assets,
    surfaces: new Map([
      ...surfaces.surfaces,
      ...result.requiredSurfaces.map((r) => [r.name, r.spec] as const),
    ]),
  };
  return { result, validation: validate(result.tree, { registry: createRegistry(theme, { surfaces: merged }) }) };
}

describe("determinism", () => {
  for (const name of FIXTURES) {
    it(`${name} compiles byte-identically twice`, () => {
      const a = JSON.stringify(compile(ir(name), { theme, surfaces }).tree);
      const b = JSON.stringify(compile(ir(name), { theme, surfaces }).tree);
      expect(a).toBe(b);
    });
  }
});

describe("output is always a legal tree", () => {
  for (const name of FIXTURES) {
    it(`${name} validates and reifies`, () => {
      const { result, validation } = check(name);
      expect(validation.errors.map((e) => `${e.code} ${e.nodeId ?? ""} ${e.path ?? ""}`)).toEqual([]);
      expect(() => reify(flatTreeSchema.parse(result.tree))).not.toThrow();
    });

    it(`${name} gives every node a unique src`, () => {
      const nodes = compile(ir(name), { theme, surfaces }).tree.nodes;
      const srcs = nodes.map((n) => n.src);
      expect(srcs.filter((s) => !s)).toEqual([]);
      expect(new Set(srcs).size).toBe(srcs.length);
    });
  }
});

describe("token refs", () => {
  it("maps every Figma naming shape the exports actually use", () => {
    expect(canonicalRef(theme, "background/sec/card", "color")).toBe("color.background_sec_card");
    expect(canonicalRef(theme, "spacing/2_5", "space")).toBe("space.2_5");
    expect(canonicalRef(theme, "15", "space")).toBe("space.15");
    expect(canonicalRef(theme, "md", "radius")).toBe("radius.md");
    expect(canonicalRef(theme, "body_md/regular", "type")).toBe("type.body_md_regular");
    // Gradients arrive with a trailing stop index that no colour ever has.
    expect(canonicalRef(theme, "sec/vert_4/0", "gradient")).toBe("gradient.sec_vert_4");
  });

  it("returns undefined rather than inventing a ref", () => {
    expect(canonicalRef(theme, "not/a/token", "color")).toBeUndefined();
    expect(canonicalRef(theme, undefined, "color")).toBeUndefined();
  });

  it("tries colour before gradient, since Figma does not say which", () => {
    expect(paintRef(theme, "text/main/high")?.kind).toBe("color");
    expect(paintRef(theme, "sec/vert_4/0")?.kind).toBe("gradient");
  });
});

describe("sizing comes from layout.sizing, not the bbox", () => {
  it("emits auto/full for hug/fill and a px only for fixed", () => {
    const { result } = check("newsletter-signup");
    const byId = new Map(result.tree.nodes.map((n) => [n.id, n]));
    // 1:5098 is hug/hug in the IR.
    const form = [...byId.values()].find((n) => n.src === "1:5098")!;
    expect((form.props.size as { w: unknown }).w).toBe("auto");
    // 1:5099 is a fixed 509x52 plate.
    const field = [...byId.values()].find((n) => n.src === "1:5099")!;
    expect((field.props.size as { w: { raw: number } }).w.raw).toBe(509);
  });

  it("never writes a px where the IR says hug or fill", () => {
    for (const name of FIXTURES) {
      const doc = ir(name);
      const index = new Map<string, ReturnType<typeof ir>["root"]>();
      (function walk(n: ReturnType<typeof ir>["root"]) {
        index.set(n.id, n);
        for (const c of n.children ?? []) walk(c);
      })(doc.root);

      for (const node of compile(doc, { theme, surfaces }).tree.nodes) {
        const src = index.get(node.src);
        if (!src || node.src === doc.rootNodeId) continue;
        const size = node.props.size as Record<string, unknown> | undefined;
        for (const axis of ["w", "h"] as const) {
          const v = size?.[axis] as { _unbound?: boolean } | undefined;
          if (v?._unbound !== true) continue;
          expect(
            `${name} ${node.id}.${axis}=${src.layout.sizing[axis]}`,
            `${name}: ${node.id} hardcodes ${axis} but the IR says ${src.layout.sizing[axis]}`,
          ).toContain("fixed");
        }
      }
    }
  });
});

describe("the mappings that were got wrong by hand", () => {
  it("orients a rotated rule by which axis fills, not by its box", () => {
    // 1:5097 is w=110 h=0 — reads horizontal from the box, and a horizontal
    // rule is width:100%, which crushed the whole row.
    const { result } = check("newsletter-signup");
    const rule = result.tree.nodes.find((n) => n.src === "1:5097")!;
    expect(rule.type).toBe("Divider");
    expect(rule.props.orientation).toBe("vertical");
  });

  it("binds an unbound value that is exactly a scale step", () => {
    expect(snapSpace(theme, 60)).toBe("space.13");
    expect(snapSpace(theme, 28)).toBe("space.7");
    expect(snapSpace(theme, 37)).toBeUndefined();
  });

  it("folds a fill plate into its parent's surface instead of emitting it", () => {
    // Figma stores a frame's background as a child rectangle at the exact
    // same size. Emitting it doubles the tree and changes nothing on screen.
    const { result } = check("newsletter-signup");
    expect(result.tree.nodes.some((n) => n.src === "1:5100")).toBe(false);
    const field = result.tree.nodes.find((n) => n.src === "1:5099")!;
    expect(field.props.surface).toMatch(/^surface\./);
  });

  it("gives every Overlay child an anchor, even when Figma calls it auto", () => {
    for (const name of FIXTURES) {
      const { result } = check(name);
      const byId = new Map(result.tree.nodes.map((n) => [n.id, n]));
      for (const node of result.tree.nodes) {
        if (node.parent === null) continue;
        if (byId.get(node.parent)?.type !== "Overlay") continue;
        expect((node.props.place as { anchor?: string } | undefined)?.anchor, `${name} ${node.id}`).toBeDefined();
      }
    }
  });

  it("keeps sibling idx contiguous even when children are absorbed", () => {
    for (const name of FIXTURES) {
      const { result } = check(name);
      const kids = new Map<string, number[]>();
      for (const n of result.tree.nodes) {
        if (n.parent === null) continue;
        (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)!).push(n.idx);
      }
      for (const [parent, list] of kids) {
        expect(list.sort((a, b) => a - b), `${name} ${parent}`).toEqual(list.map((_, i) => i));
      }
    }
  });
});

describe("ids", () => {
  it("uses the layer name when it says something", () => {
    expect(slug("Photos (16:9)")).toBe("photos_16_9");
    expect(isMeaningful("Breadcrumbs")).toBe(true);
  });

  it("falls back when Figma autogenerated the name", () => {
    for (const junk of ["Frame 427320816", "Ellipse 13", "Vector", "Group 12", "Rectangle"]) {
      expect(isMeaningful(junk), junk).toBe(false);
    }
  });

  it("never collides", () => {
    for (const name of FIXTURES) {
      const ids = compile(ir(name), { theme, surfaces }).tree.nodes.map((n) => n.id);
      expect(new Set(ids).size, name).toBe(ids.length);
    }
  });
});

describe("what it refuses to guess", () => {
  it("leaves text literal — bindings are not derivable from the IR", () => {
    const { result } = check("newsletter-signup");
    const texts = result.tree.nodes.filter((n) => n.type === "Text");
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((t) => !/^\{.*\}$/.test(String(t.props.content)))).toBe(true);
  });

  it("reports a required surface rather than inventing a token", () => {
    const { result } = check("newsletter-signup");
    expect(result.requiredSurfaces.length).toBeGreaterThan(0);
    for (const r of result.requiredSurfaces) {
      expect(r.spec).toBeTruthy();
      expect(r.srcs.length).toBeGreaterThan(0);
    }
  });

  it("flags every icon it could not identify", () => {
    const { result } = check("newsletter-signup");
    const icons = result.tree.nodes.filter((n) => n.type === "Icon");
    const flagged = result.notes.filter((n) => n.kind === "unknown-icon");
    expect(flagged.length).toBe(icons.length);
  });
});
