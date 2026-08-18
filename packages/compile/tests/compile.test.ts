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
import { parseFrameIRDocument, type FrameIRDocument } from "@fanos/surface-canvas/ir";
import { compile } from "../src/compile.js";
import { isMeaningful, slug } from "../src/ids.js";
import { canonicalRef, paintRef } from "../src/refs.js";
import { snapSpace, unhuggableAxes } from "../src/props.js";
import { declaredType, primitivesFromNames } from "../src/primitives.js";

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
        /**
         * The one legal exception: a node whose children are ALL absolutely
         * positioned has nothing in flow to hug, so CSS collapses it to zero.
         * Those axes are pinned deliberately — see `unhuggableAxes`.
         */
        const pinnable = unhuggableAxes(src);

        for (const axis of ["w", "h"] as const) {
          const v = size?.[axis] as { _unbound?: boolean } | undefined;
          if (v?._unbound !== true) continue;
          if (pinnable[axis]) continue;
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

/**
 * A quarter-turned node reports its box unrotated, so `relBbox` is transposed
 * against the space it actually occupies. Reading it literally turned a 552x1
 * hairline rule into a 552x552 grey square — sixteen of them in one real
 * fixtures page, which alone took the render from ~1100px tall to 5913px.
 */
describe("rotated geometry", () => {
  const rule = (rotation: number): FrameIRDocument =>
    parseFrameIRDocument({
      fileKey: "test",
      fileName: "t",
      pageName: "p",
      rootNodeId: "1:1",
      extractedAt: "2026-01-01T00:00:00.000Z",
      irVersion: "1.2.0",
      breakpointHint: 552,
      root: {
        id: "1:1",
        name: "Root",
        type: "FRAME",
        layout: {
          mode: "vertical",
          gap: { value: 0, unbound: false },
          padding: {
            top: { value: 0, unbound: false },
            right: { value: 0, unbound: false },
            bottom: { value: 0, unbound: false },
            left: { value: 0, unbound: false },
          },
          align: "MIN",
          justify: "MIN",
          wrap: false,
          sizing: { w: "fixed", h: "hug" },
          positioning: "auto",
        },
        geometry: {
          bbox: { x: 0, y: 0, w: 552, h: 100 },
          relBbox: { x: 0, y: 0, w: 552, h: 100 },
          rotation: 0,
          aspect: 5.52,
          aspectBucket: "ultrawide",
        },
        fill: null,
        stroke: null,
        radius: null,
        effects: [],
        opacity: 1,
        clipsContent: false,
        structuralSignature: "root",
        canonicalSignature: "root",
        repeatedSiblings: 1,
        depth: 0,
        childCount: 1,
        children: [
          {
            id: "1:2",
            name: "Rule",
            type: "FRAME",
            layout: {
              mode: "horizontal",
              gap: { value: 0, unbound: false },
              padding: {
                top: { value: 0, unbound: false },
                right: { value: 0, unbound: false },
                bottom: { value: 0, unbound: false },
                left: { value: 0, unbound: false },
              },
              align: "CENTER",
              justify: "CENTER",
              wrap: false,
              // fill width, FIXED height — the height is read from the box
              sizing: { w: "fill", h: "fixed" },
              positioning: "auto",
            },
            geometry: {
              // As Figma reports a 1x552 rule laid flat: absolute extent is
              // 552x1, the node's own dimensions are still 1x552.
              bbox: { x: 0, y: 0, w: 552, h: 1 },
              relBbox: { x: 0, y: 0, w: 1, h: 552 },
              rotation,
              aspect: 552,
              aspectBucket: "ultrawide",
            },
            fill: null,
            stroke: null,
            radius: null,
            effects: [],
            opacity: 1,
            clipsContent: false,
            structuralSignature: "rule",
            canonicalSignature: "rule",
            repeatedSiblings: 1,
            depth: 1,
            childCount: 0,
            children: [],
          },
        ],
      },
    });

  const heightOf = (doc: FrameIRDocument) => {
    const tree = compile(doc, { theme, surfaces }).tree;
    const node = tree.nodes.find((n) => n.src === "1:2");
    return (node?.props as { size?: { h?: unknown } } | undefined)?.size?.h;
  };

  it("takes the rotated height for a quarter-turned node", () => {
    expect(heightOf(rule(90))).toEqual({ raw: 1, _unbound: true });
    expect(heightOf(rule(-90))).toEqual({ raw: 1, _unbound: true });
  });

  it("leaves an upright node's box alone", () => {
    expect(heightOf(rule(0))).toEqual({ raw: 552, _unbound: true });
  });

  /**
   * An arbitrary angle has no rectangular layout box, and this compiler emits
   * no transform. Approximating one would move the node; the honest output is
   * the box Figma gave.
   */
  it("does not transpose a non-quarter rotation", () => {
    expect(heightOf(rule(45))).toEqual({ raw: 552, _unbound: true });
  });

  it("defaults rotation to 0 for IR captured before the field existed", () => {
    const doc = rule(90);
    const child = doc.root.children[0]!;
    delete (child.geometry as { rotation?: number }).rotation;
    const reparsed = parseFrameIRDocument(JSON.parse(JSON.stringify(doc)));
    expect(reparsed.root.children[0]!.geometry.rotation).toBe(0);
  });
});

/**
 * A rule drawn as a childless filled FRAME, not a VECTOR. The fixtures card
 * uses these; classifying them as Box painted their declared 16px padding and
 * turned every 552x1 hairline into a 33px grey bar.
 */
describe("hairline frames", () => {
  const hairline = (over: Record<string, unknown>): FrameIRDocument => {
    const doc = JSON.parse(
      JSON.stringify({
        fileKey: "t",
        fileName: "t",
        pageName: "p",
        rootNodeId: "1:1",
        extractedAt: "2026-01-01T00:00:00.000Z",
        irVersion: "1.2.0",
        breakpointHint: 552,
        root: {
          id: "1:1",
          name: "Root",
          type: "FRAME",
          layout: {
            mode: "vertical",
            gap: { value: 0, unbound: false },
            padding: {
              top: { value: 0, unbound: false },
              right: { value: 0, unbound: false },
              bottom: { value: 0, unbound: false },
              left: { value: 0, unbound: false },
            },
            align: "MIN",
            justify: "MIN",
            wrap: false,
            sizing: { w: "fixed", h: "hug" },
            positioning: "auto",
          },
          geometry: {
            bbox: { x: 0, y: 0, w: 552, h: 100 },
            relBbox: { x: 0, y: 0, w: 552, h: 100 },
            rotation: 0,
            aspect: 5.52,
            aspectBucket: "ultrawide",
          },
          fill: null,
          stroke: null,
          radius: null,
          effects: [],
          opacity: 1,
          clipsContent: false,
          structuralSignature: "root",
          canonicalSignature: "root",
          repeatedSiblings: 1,
          depth: 0,
          childCount: 1,
          children: [
            {
              id: "1:2",
              name: "Rule",
              type: "FRAME",
              layout: {
                mode: "horizontal",
                gap: { value: 0, unbound: false },
                // 16px padding declared inside a 1px-tall box
                padding: {
                  top: { value: 16, unbound: false },
                  right: { value: 16, unbound: false },
                  bottom: { value: 16, unbound: false },
                  left: { value: 16, unbound: false },
                },
                align: "CENTER",
                justify: "CENTER",
                wrap: false,
                sizing: { w: "fill", h: "fixed" },
                positioning: "auto",
              },
              geometry: {
                bbox: { x: 0, y: 0, w: 552, h: 1 },
                relBbox: { x: 0, y: 0, w: 552, h: 1 },
                rotation: 0,
                aspect: 552,
                aspectBucket: "ultrawide",
              },
              fill: { unbound: false, tokenRef: "border/main/disable" },
              stroke: null,
              radius: null,
              effects: [],
              opacity: 1,
              clipsContent: false,
              structuralSignature: "rule",
              canonicalSignature: "rule",
              repeatedSiblings: 1,
              depth: 1,
              childCount: 0,
              children: [],
            },
          ],
        },
      }),
    );
    Object.assign(doc.root.children[0], over);
    return parseFrameIRDocument(doc);
  };

  const ruleNode = (doc: FrameIRDocument) =>
    compile(doc, { theme, surfaces }).tree.nodes.find((n) => n.src === "1:2");

  it("classifies a childless filled hairline frame as a Divider", () => {
    expect(ruleNode(hairline({}))?.type).toBe("Divider");
  });

  /**
   * The real thing. A rule nested in a component instance comes back through a
   * transform as 1.0000104904174805 wide, so an exact `<= 1` bound classified
   * every hairline in the fixtures card as a box.
   */
  it("tolerates the sub-pixel drift a component instance introduces", () => {
    const drifted = hairline({});
    drifted.root.children[0]!.geometry.relBbox.h = 1.0000104904174805;
    drifted.root.children[0]!.geometry.bbox.h = 1.0000346191038147;
    expect(ruleNode(parseFrameIRDocument(JSON.parse(JSON.stringify(drifted))))?.type).toBe(
      "Divider",
    );
  });

  it("still treats a genuinely thin box as a box", () => {
    const thin = hairline({});
    thin.root.children[0]!.geometry.relBbox.h = 4;
    expect(ruleNode(parseFrameIRDocument(JSON.parse(JSON.stringify(thin))))?.type).not.toBe(
      "Divider",
    );
  });

  it("drops padding on a rule — a 1px box with 16px padding is 33px tall", () => {
    expect(ruleNode(hairline({}))?.props.space).toBeUndefined();
  });

  it("leaves an unpainted sliver alone rather than inventing a border", () => {
    expect(ruleNode(hairline({ fill: null }))?.type).not.toBe("Divider");
  });

  it("does not treat a hairline WITH children as a rule", () => {
    const withKid = hairline({});
    const rule = withKid.root.children[0]!;
    rule.children = [{ ...rule, id: "1:3", children: [], childCount: 0, depth: 2 }];
    rule.childCount = 1;
    expect(ruleNode(parseFrameIRDocument(JSON.parse(JSON.stringify(withKid))))?.type).not.toBe(
      "Divider",
    );
  });
});

/**
 * Hug is only reproducible when something is in flow to hug.
 *
 * Figma resolves a hugging frame to a concrete box around absolutely-positioned
 * children; CSS gives out-of-flow children no intrinsic contribution at all, so
 * the same node collapses. Measured on the fixtures page: a 333px overlay of
 * three placed buttons rendered 72px, shifting its whole subtree by 262px.
 */
describe("hug that cannot hug", () => {
  const kid = (id: string, positioning: "auto" | "absolute", w: number, h: number) => ({
    id,
    name: id,
    type: "FRAME" as const,
    layout: {
      mode: "none" as const,
      gap: { value: 0, unbound: false },
      padding: {
        top: { value: 0, unbound: false },
        right: { value: 0, unbound: false },
        bottom: { value: 0, unbound: false },
        left: { value: 0, unbound: false },
      },
      align: "MIN",
      justify: "MIN",
      wrap: false,
      sizing: { w: "fixed" as const, h: "fixed" as const },
      positioning,
    },
    geometry: {
      bbox: { x: 0, y: 0, w, h },
      relBbox: { x: 0, y: 0, w, h },
      rotation: 0,
      aspect: w / h,
      aspectBucket: "landscape" as const,
    },
    fill: { unbound: false, tokenRef: "border/main/disable" },
    stroke: null,
    radius: null,
    effects: [],
    opacity: 1,
    clipsContent: false,
    structuralSignature: id,
    canonicalSignature: id,
    repeatedSiblings: 1,
    depth: 2,
    childCount: 0,
    children: [],
  });

  const parent = (over: {
    mode?: "none" | "horizontal";
    sizing?: { w: string; h: string };
    kids: ReturnType<typeof kid>[];
  }) =>
    parseFrameIRDocument(
      JSON.parse(
        JSON.stringify({
          fileKey: "t",
          fileName: "t",
          pageName: "p",
          rootNodeId: "1:1",
          extractedAt: "2026-01-01T00:00:00.000Z",
          irVersion: "1.2.0",
          breakpointHint: 552,
          root: {
            ...kid("1:1", "auto", 552, 200),
            id: "1:1",
            layout: {
              ...kid("1:1", "auto", 552, 200).layout,
              mode: "vertical",
              sizing: { w: "fixed", h: "hug" },
            },
            children: [
              {
                ...kid("1:2", "auto", 333, 40),
                layout: {
                  ...kid("1:2", "auto", 333, 40).layout,
                  mode: over.mode ?? "none",
                  sizing: over.sizing ?? { w: "hug", h: "hug" },
                },
                childCount: over.kids.length,
                children: over.kids,
              },
            ],
          },
        }),
      ),
    );

  const sizeOf = (doc: FrameIRDocument) => {
    const n = compile(doc, { theme, surfaces }).tree.nodes.find((x) => x.src === "1:2");
    return (n?.props as { size?: Record<string, unknown> } | undefined)?.size;
  };

  it("pins both axes when every child is absolutely positioned", () => {
    const s = sizeOf(parent({ kids: [kid("1:3", "absolute", 72, 40)] }));
    expect(s?.w).toEqual({ raw: 333, _unbound: true });
    expect(s?.h).toEqual({ raw: 40, _unbound: true });
  });

  it("leaves hug alone when even one child is in flow", () => {
    const s = sizeOf(
      parent({ kids: [kid("1:3", "absolute", 72, 40), kid("1:4", "auto", 60, 40)] }),
    );
    expect(s?.w).toBe("auto");
    expect(s?.h).toBe("auto");
  });

  /** Flow, not node type: an auto-layout Stack fails identically. */
  it("applies to an auto-layout container too, not just Overlay", () => {
    const s = sizeOf(parent({ mode: "horizontal", kids: [kid("1:3", "absolute", 72, 40)] }));
    expect(s?.w).toEqual({ raw: 333, _unbound: true });
  });

  it("pins only the hugging axis, leaving fill alone", () => {
    const s = sizeOf(
      parent({ sizing: { w: "hug", h: "fill" }, kids: [kid("1:3", "absolute", 72, 40)] }),
    );
    expect(s?.w).toEqual({ raw: 333, _unbound: true });
    expect(s?.h).toBe("full");
  });

  it("records the departure from intrinsic sizing", () => {
    const doc = parent({ kids: [kid("1:3", "absolute", 72, 40)] });
    const notes = compile(doc, { theme, surfaces }).notes.filter((n) => n.kind === "pinned-size");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toContain("nothing in flow");
  });
});

/**
 * An absolutely-positioned child is an exception inside a layout, not an
 * abandonment of it. Demoting the frame to an Overlay anchored every sibling
 * and threw the row away — a 333px button row rendered 72px wide and shifted
 * its subtree by 262px.
 */
describe("auto-layout survives an absolute child", () => {
  const frame = (positionings: ("auto" | "absolute")[], mode: "horizontal" | "none") => {
    const child = (id: string, positioning: "auto" | "absolute", x: number) => ({
      id,
      name: id,
      type: "FRAME" as const,
      layout: {
        mode: "none" as const,
        gap: { value: 0, unbound: false },
        padding: {
          top: { value: 0, unbound: false },
          right: { value: 0, unbound: false },
          bottom: { value: 0, unbound: false },
          left: { value: 0, unbound: false },
        },
        align: "MIN",
        justify: "MIN",
        wrap: false,
        sizing: { w: "fixed" as const, h: "fixed" as const },
        positioning,
      },
      geometry: {
        bbox: { x, y: 0, w: 60, h: 40 },
        relBbox: { x, y: 0, w: 60, h: 40 },
        rotation: 0,
        aspect: 1.5,
        aspectBucket: "landscape" as const,
      },
      fill: { unbound: false, tokenRef: "border/main/disable" },
      stroke: null,
      radius: null,
      effects: [],
      opacity: 1,
      clipsContent: false,
      structuralSignature: id,
      canonicalSignature: id,
      repeatedSiblings: 1,
      depth: 2,
      childCount: 0,
      children: [],
    });

    const kids = positionings.map((p, i) => child(`1:${i + 3}`, p, i * 76));
    return parseFrameIRDocument(
      JSON.parse(
        JSON.stringify({
          fileKey: "t",
          fileName: "t",
          pageName: "p",
          rootNodeId: "1:1",
          extractedAt: "2026-01-01T00:00:00.000Z",
          irVersion: "1.2.0",
          breakpointHint: 552,
          root: {
            ...child("1:1", "auto", 0),
            layout: {
              ...child("1:1", "auto", 0).layout,
              mode: "vertical",
              sizing: { w: "fixed", h: "hug" },
            },
            geometry: {
              bbox: { x: 0, y: 0, w: 552, h: 200 },
              relBbox: { x: 0, y: 0, w: 552, h: 200 },
              rotation: 0,
              aspect: 2.76,
              aspectBucket: "wide" as const,
            },
            childCount: 1,
            children: [
              {
                ...child("1:2", "auto", 0),
                layout: {
                  ...child("1:2", "auto", 0).layout,
                  mode,
                  sizing: { w: "hug", h: "hug" },
                },
                geometry: {
                  bbox: { x: 0, y: 0, w: 333, h: 40 },
                  relBbox: { x: 0, y: 0, w: 333, h: 40 },
                  rotation: 0,
                  aspect: 8.3,
                  aspectBucket: "ultrawide" as const,
                },
                childCount: kids.length,
                children: kids,
              },
            ],
          },
        }),
      ),
    );
  };

  const compiled = (doc: FrameIRDocument) => {
    const tree = compile(doc, { theme, surfaces }).tree;
    const container = tree.nodes.find((n) => n.src === "1:2")!;
    const kids = tree.nodes.filter((n) => n.parent === container.id);
    return { container, kids };
  };

  it("stays a Stack when one child is absolutely positioned", () => {
    const { container } = compiled(frame(["absolute", "auto", "auto"], "horizontal"));
    expect(container.type).toBe("Stack");
  });

  it("places only the child Figma placed, leaving siblings in flow", () => {
    const { kids } = compiled(frame(["absolute", "auto", "auto"], "horizontal"));
    const placed = kids.filter((k) => k.props.place !== undefined);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.src).toBe("1:3");
  });

  it("keeps hug on the container, because something is still in flow", () => {
    const { container } = compiled(frame(["absolute", "auto", "auto"], "horizontal"));
    expect((container.props.size as Record<string, unknown>).w).toBe("auto");
  });

  it("keeps the row's direction and gap", () => {
    const { container } = compiled(frame(["absolute", "auto", "auto"], "horizontal"));
    expect(container.props.direction).toBe("row");
  });

  /** No auto-layout means Figma flows nothing — that is still an Overlay. */
  it("still emits an Overlay when the frame has no auto-layout", () => {
    const { container, kids } = compiled(frame(["auto", "auto"], "none"));
    expect(container.type).toBe("Overlay");
    expect(kids.every((k) => k.props.place !== undefined)).toBe(true);
  });
});


/**
 * Uploaded background assets.
 *
 * An asset is an image the designer exported from Figma and dropped in, bound
 * to the element it should paint. It is not a layer in the design, so it never
 * appears in the tree as a node — it paints the target's SURFACE, and whatever
 * decoration that element contains is already inside the picture.
 */
describe("uploaded background assets", () => {
  const pad = {
    top: { value: 0, unbound: false },
    right: { value: 0, unbound: false },
    bottom: { value: 0, unbound: false },
    left: { value: 0, unbound: false },
  };
  const layout = {
    mode: "none" as const,
    gap: null,
    padding: pad,
    align: null,
    justify: null,
    wrap: false,
    sizing: { w: "fixed" as const, h: "fixed" as const },
    positioning: "auto" as const,
  };
  const at = (x: number, y: number, w: number, h: number) => ({
    bbox: { x, y, w, h },
    relBbox: { x, y, w, h },
    rotation: 0,
    aspect: w / (h || 1),
    aspectBucket: "wide" as const,
  });
  const base = {
    layout,
    fill: null,
    stroke: null,
    radius: null,
    effects: [],
    opacity: 1,
    clipsContent: false,
    structuralSignature: "s",
    canonicalSignature: "c",
    repeatedSiblings: 1,
    depth: 1,
    childCount: 0,
    children: [],
  };

  const asset = {
    role: "background" as const,
    name: "top_header",
    imageHash: "hash-a",
    fileName: "Top Header@2x.png",
    width: 2732,
    height: 836,
    targetId: "1:2",
    targetName: "Top Header",
    fit: "cover" as const,
    mapping: "auto" as const,
  };

  /** A header the way the real one is: decoration, and a headline beside it. */
  function page(over: { withText?: boolean; fit?: "cover" | "repeat" } = {}) {
    const binding = over.fit ? { ...asset, fit: over.fit } : asset;
    const decoration = [
      { ...base, id: "1:3", name: "plate", type: "VECTOR" as const, geometry: at(0, 0, 1366, 418) },
      {
        ...base,
        id: "1:4",
        name: "wave",
        type: "IMAGE" as const,
        geometry: at(0, 0, 1366, 418),
        image: { fit: "FILL", hasImageFill: true },
      },
      { ...base, id: "1:5", name: "cutout", type: "VECTOR" as const, geometry: at(0, 302, 1366, 116) },
    ];
    const headline = {
      ...base,
      id: "1:6",
      name: "Headline",
      type: "TEXT" as const,
      geometry: at(40, 40, 400, 60),
      text: {
        characters: "FIXTURES",
        styleRef: "body_md/regular",
        unbound: false,
        fontSize: 40,
        fontFamily: "Inter",
        fontWeight: 700,
        lineHeight: 48,
        autoResize: "NONE" as const,
        lines: 1,
      },
    };

    return parseFrameIRDocument({
      fileKey: "t",
      fileName: "t",
      pageName: "p",
      rootNodeId: "1:1",
      extractedAt: "2026-01-01T00:00:00.000Z",
      irVersion: "1.6.0",
      breakpointHint: 1366,
      assets: [binding],
      root: {
        ...base,
        id: "1:1",
        name: "Page",
        type: "FRAME",
        geometry: at(0, 0, 1366, 900),
        depth: 0,
        childCount: 1,
        children: [
          {
            ...base,
            id: "1:2",
            name: "Top Header",
            type: "INSTANCE",
            geometry: at(0, 0, 1366, 418),
            background: binding,
            childCount: over.withText ? 4 : 3,
            children: over.withText ? [...decoration, headline] : decoration,
          },
        ],
      },
    });
  }

  it("paints the target's surface and requires the asset", () => {
    const result = compile(page(), { theme, surfaces });
    const header = result.tree.nodes.find((n) => n.src === "1:2")!;

    expect(result.requiredAssets.map((a) => a.ref)).toEqual(["asset.texture.top_header"]);
    const spec = result.requiredSurfaces.find((s) => `surface.${s.name}` === header.props.surface);
    expect(spec?.spec.layers).toContainEqual({
      type: "image",
      ref: "asset.texture.top_header",
      fit: "cover",
    });
  });

  /**
   * The whole point. The designer exported that region, so the plate, the wave
   * and the cutout are IN the photo — drawing them again paints them on top of
   * the picture that already contains them.
   */
  it("absorbs the decoration that is already inside the photo", () => {
    const result = compile(page(), { theme, surfaces });
    for (const id of ["1:3", "1:4", "1:5"]) {
      expect(result.tree.nodes.some((n) => n.src === id), `${id} should be absorbed`).toBe(false);
    }
    expect(result.notes.some((n) => n.kind === "absorbed")).toBe(true);
  });

  /**
   * Never text. Baking a headline into a bitmap freezes copy the CMS is meant
   * to change, and a background photo is not a licence to do it.
   */
  it("keeps text over a background photo", () => {
    const result = compile(page({ withText: true }), { theme, surfaces });
    const headline = result.tree.nodes.find((n) => n.src === "1:6");
    expect(headline?.type).toBe("Text");
    expect(headline?.props.content).toBe("FIXTURES");
  });

  it("carries the designer's fit onto the surface layer", () => {
    const result = compile(page({ fit: "repeat" }), { theme, surfaces });
    const layer = result.requiredSurfaces
      .flatMap((s) => s.spec.layers ?? [])
      .find((l) => l.type === "image");
    expect(layer).toMatchObject({ fit: "repeat" });
  });

  it("names the file the background came from, in the note", () => {
    const result = compile(page(), { theme, surfaces });
    const note = result.notes.find((n) => n.kind === "background-asset");
    expect(note?.message).toContain("Top Header@2x.png");
  });

  /** A 1.5.0 binding has no uploaded bytes, so it is dropped rather than honoured. */
  it("ignores a binding from the marking era", () => {
    const doc = parseFrameIRDocument({
      fileKey: "t",
      fileName: "t",
      pageName: "p",
      rootNodeId: "1:1",
      extractedAt: "2026-01-01T00:00:00.000Z",
      irVersion: "1.5.0",
      breakpointHint: 1366,
      assets: [
        {
          role: "background",
          name: "old",
          sources: [{ id: "1:3", name: "plate" }],
          targetId: "1:1",
          targetName: "Page",
        },
      ],
      root: { ...base, id: "1:1", name: "Page", type: "FRAME", geometry: at(0, 0, 100, 100), depth: 0 },
    });

    expect(doc.assets).toEqual([]);
    expect(compile(doc, { theme, surfaces }).requiredAssets).toEqual([]);
  });
});

describe("vector artwork", () => {
  const pad = {
    top: { value: 0, unbound: false },
    right: { value: 0, unbound: false },
    bottom: { value: 0, unbound: false },
    left: { value: 0, unbound: false },
  };
  const layout = {
    mode: "none" as const,
    gap: null,
    padding: pad,
    align: null,
    justify: null,
    wrap: false,
    sizing: { w: "fixed" as const, h: "fixed" as const },
    positioning: "auto" as const,
  };
  const at = (x: number, y: number, w: number, h: number) => ({
    bbox: { x, y, w, h },
    relBbox: { x, y, w, h },
    rotation: 0,
    aspect: w / (h || 1),
    aspectBucket: "wide" as const,
  });
  const base = {
    layout,
    fill: null,
    stroke: null,
    radius: null,
    effects: [],
    opacity: 1,
    clipsContent: false,
    structuralSignature: "s",
    canonicalSignature: "c",
    repeatedSiblings: 1,
    depth: 1,
    childCount: 0,
    children: [],
  };
  const vector = (id: string, name: string, w = 4, h = 4) => ({
    ...base,
    id,
    name,
    type: "VECTOR" as const,
    geometry: at(0, 0, w, h),
  });

  function page(child: unknown) {
    return parseFrameIRDocument({
      fileKey: "t",
      fileName: "t",
      pageName: "p",
      rootNodeId: "1:1",
      extractedAt: "2026-01-01T00:00:00.000Z",
      irVersion: "1.4.0",
      breakpointHint: 1366,
      assets: [],
      root: {
        ...base,
        id: "1:1",
        name: "Page",
        type: "FRAME",
        geometry: at(0, 0, 1366, 800),
        depth: 0,
        childCount: 1,
        children: [child],
      },
    });
  }

  /**
   * The regression that produced the noise squares. A club crest is 99 vector
   * paths in a 44x30 box; the old six-child cap rejected it, so the compiler
   * recursed and emitted 99 unknown Icons — 99 dashed placeholders stacked
   * inside a 44x30 square. One page produced 408 of them.
   */
  it("collapses a 99-path crest into a single Icon", () => {
    const crest = {
      ...base,
      id: "2:1",
      name: "Teams",
      type: "INSTANCE" as const,
      geometry: at(0, 0, 60, 60),
      childCount: 1,
      children: [
        {
          ...base,
          id: "2:2",
          name: "manchester-super-giants 1",
          type: "FRAME" as const,
          geometry: at(0, 0, 44, 30),
          childCount: 99,
          children: Array.from({ length: 99 }, (_, i) => vector(`2:${100 + i}`, `Vector ${i}`)),
        },
      ],
    };

    const result = compile(page(crest), { theme, surfaces });
    const icons = result.tree.nodes.filter((n) => n.type === "Icon");
    expect(icons).toHaveLength(1);
    // Named after the layer that identifies the club, not the "Teams" instance
    // every crest on the page shares.
    expect((icons[0]?.props as { name?: string }).name).toBe("manchester_super_giants_1");
  });

  it("collapses a crest wrapped in SVG-import clip scaffolding", () => {
    const crest = {
      ...base,
      id: "3:1",
      name: "Teams",
      type: "INSTANCE" as const,
      geometry: at(0, 0, 60, 60),
      childCount: 1,
      children: [
        {
          ...base,
          id: "3:2",
          name: "birmingham-phoenix 1",
          type: "FRAME" as const,
          geometry: at(0, 0, 44, 44),
          childCount: 1,
          children: [
            {
              ...base,
              id: "3:3",
              name: "Clip path group",
              type: "GROUP" as const,
              geometry: at(0, 0, 44, 44),
              childCount: 2,
              children: [vector("3:4", "Vector"), vector("3:5", "Vector")],
            },
          ],
        },
      ],
    };

    const result = compile(page(crest), { theme, surfaces });
    const icons = result.tree.nodes.filter((n) => n.type === "Icon");
    expect(icons).toHaveLength(1);
    // "Clip path group" is scaffolding, not a name — it must not win.
    expect((icons[0]?.props as { name?: string }).name).toBe("birmingham_phoenix_1");
  });

  /**
   * The other half. The Icon renderer takes ONE size and writes it to both
   * width and height, so a 1368x116 swoosh classified as an icon painted a
   * 1368x1368 block over the page.
   */
  it("emits an oversized vector as a Box, never an Icon", () => {
    const swoosh = {
      ...vector("4:1", "Vector 101", 1368, 116),
      fill: { unbound: false, tokenRef: "color/background/main_container" },
    };

    const result = compile(page(swoosh), { theme, surfaces });
    const node = result.tree.nodes.find((n) => n.src === "4:1");

    expect(node?.type).toBe("Box");
    // Its real box, not a square.
    expect((node?.props as { size?: unknown }).size).toEqual({
      w: { raw: 1368, _unbound: true },
      h: { raw: 116, _unbound: true },
    });
    expect(result.notes.some((n) => n.kind === "decorative-vector")).toBe(true);
  });

  it("names the Assets tab as the fix for artwork it cannot reproduce", () => {
    const result = compile(page(vector("5:1", "Header Swoosh", 900, 400)), { theme, surfaces });
    const note = result.notes.find((n) => n.kind === "decorative-vector");
    expect(note?.message).toContain("900×400");
    expect(note?.message).toContain("Surface Canvas");
  });

  it("still treats an icon-sized vector as an Icon", () => {
    const result = compile(page(vector("6:1", "arrow-right", 24, 24)), { theme, surfaces });
    const node = result.tree.nodes.find((n) => n.src === "6:1");
    expect(node?.type).toBe("Icon");
    expect((node?.props as { name?: string }).name).toBe("arrow_right");
  });

  /** A cluster holding real content is not a glyph, however small. */
  it("does not collapse a small group that contains text", () => {
    const badge = {
      ...base,
      id: "7:1",
      name: "Badge",
      type: "FRAME" as const,
      geometry: at(0, 0, 40, 40),
      childCount: 2,
      children: [
        vector("7:2", "Vector"),
        {
          ...base,
          id: "7:3",
          name: "Label",
          type: "TEXT" as const,
          geometry: at(0, 0, 20, 10),
          text: {
            characters: "LIVE",
            styleRef: "body_md/regular",
            unbound: false,
            fontSize: 10,
            fontFamily: "Inter",
            fontWeight: 700,
            lineHeight: 12,
            autoResize: "NONE" as const,
            lines: 1,
          },
        },
      ],
    };

    const result = compile(page(badge), { theme, surfaces });
    // Not collapsed: the label survives as its own node, and the badge is not
    // an Icon. A cluster holding content is a container, whatever its size.
    expect(result.tree.nodes.some((n) => n.src === "7:3")).toBe(true);
    expect(result.tree.nodes.find((n) => n.src === "7:1")?.type).not.toBe("Icon");
  });
});

/**
 * Declared primitives.
 *
 * The one classification that cannot be read off the IR. A button IS an
 * auto-layout frame with a label in it — at rest there is no difference, and
 * the difference is that one is pressable, which Figma has nowhere to record.
 * So the designer declares it by naming the master, and the entry is stored
 * against the `componentKey`, which survives the rename that a name does not.
 */
describe("declared primitives", () => {
  const KEY = "c0ffee1234";
  const pad = (v: number) => ({ value: v, unbound: false });
  const at = (x: number, y: number, w: number, h: number) => ({
    bbox: { x, y, w, h },
    relBbox: { x, y, w, h },
    rotation: 0,
    aspect: w / (h || 1),
    aspectBucket: "wide" as const,
  });
  const row = (px = 0, py = 0) => ({
    mode: "horizontal" as const,
    gap: { value: 4, unbound: false },
    padding: { top: pad(py), right: pad(px), bottom: pad(py), left: pad(px) },
    align: "CENTER" as const,
    justify: "CENTER" as const,
    wrap: false,
    sizing: { w: "hug" as const, h: "hug" as const },
    positioning: "auto" as const,
  });
  const base = {
    fill: null,
    stroke: null,
    radius: null,
    effects: [],
    opacity: 1,
    clipsContent: false,
    structuralSignature: "s",
    canonicalSignature: "c",
    repeatedSiblings: 1,
    depth: 1,
    childCount: 0,
    children: [],
  };

  /**
   * The shape a real one arrives in: an INSTANCE wrapping the master, which
   * holds the label and a glyph. `atom_button` in the news section is exactly
   * this, and reading the outer frame gives a button with no padding.
   */
  function frame(over: { label?: string | null; paint?: string; type?: string; name?: string } = {}) {
    const label =
      over.label === null
        ? []
        : [
            {
              ...base,
              id: "2:3",
              name: "atom_text",
              type: "TEXT" as const,
              layout: row(),
              geometry: at(16, 6, 64, 20),
              fill: {
                tokenRef: over.paint ?? "button/outline/style_2/text/default",
                unbound: false,
              },
              text: {
                characters: over.label ?? "VIEW MORE",
                styleRef: "button/sm",
                unbound: false,
                fontSize: 10,
                fontFamily: "Montserrat",
                fontWeight: 700,
                lineHeight: 20,
                autoResize: "WIDTH_AND_HEIGHT" as const,
                lines: 1,
              },
            },
          ];

    return parseFrameIRDocument({
      fileKey: "t",
      fileName: "t",
      pageName: "p",
      rootNodeId: "1:1",
      extractedAt: "2026-01-01T00:00:00.000Z",
      irVersion: "1.7.0",
      breakpointHint: 400,
      root: {
        ...base,
        id: "1:1",
        name: "Header",
        type: "FRAME",
        layout: row(),
        geometry: at(0, 0, 400, 32),
        depth: 0,
        childCount: 1,
        children: [
          {
            ...base,
            id: "2:1",
            name: over.name ?? "atom_button",
            type: (over.type ?? "INSTANCE") as "INSTANCE",
            componentKey: KEY,
            layout: row(),
            geometry: at(0, 0, 118, 32),
            childCount: 1,
            children: [
              {
                ...base,
                id: "2:2",
                name: "atom_button_master",
                type: "INSTANCE" as const,
                layout: row(16, 6),
                geometry: at(0, 0, 118, 32),
                childCount: label.length + 1,
                children: [
                  ...label,
                  {
                    ...base,
                    id: "2:4",
                    name: "atom_icon_arrow_up_right",
                    type: "INSTANCE" as const,
                    layout: row(),
                    geometry: at(84, 7, 18, 18),
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  }

  type Primitives = NonNullable<Parameters<typeof compile>[1]["primitives"]>;
  const compiled = (primitives?: Primitives) =>
    compile(frame(), { theme, surfaces, ...(primitives ? { primitives } : {}) });
  const buttonOf = (primitives?: Primitives) =>
    compiled(primitives).tree.nodes.find((n) => n.type === "Button");

  /** A component whose name says nothing is still just frames. */
  it("compiles as frames when neither the name nor the map declares one", () => {
    const result = compile(frame({ name: "Primary CTA" }), { theme, surfaces });
    expect(result.tree.nodes.some((n) => n.type === "Button")).toBe(false);
    expect(result.tree.nodes.find((n) => n.src === "2:1")?.type).toBe("Stack");
  });

  /**
   * The designer's own channel: naming the master is the whole declaration, so
   * the common case needs nothing wired, stored or configured.
   */
  it("reads the declaration off the component name", () => {
    const result = compile(frame(), { theme, surfaces });
    expect(result.tree.nodes.find((n) => n.type === "Button")?.props.label).toBe("VIEW MORE");
  });

  it("matches the prefix, not a bare name Figma also generates", () => {
    expect(declaredType("atom_button")).toBe("Button");
    expect(declaredType("Atom Button")).toBe("Button");
    expect(declaredType("atom_button_master")).toBe("Button");
    // Figma names layers `Button`/`Image` itself; a bare name cannot declare.
    expect(declaredType("Button")).toBeUndefined();
    expect(declaredType("atom_tabs")).toBeUndefined();
  });

  it("keys the declaration on componentKey, so a rename cannot break it", () => {
    expect(primitivesFromNames(frame())).toEqual({ [KEY]: "Button" });
  });

  /** An explicit entry is the one someone typed on purpose, so it wins. */
  it("lets an explicit map correct a component the name gets wrong", () => {
    const result = compile(frame({ name: "Primary CTA" }), {
      theme,
      surfaces,
      primitives: { [KEY]: "Button" },
    });
    expect(result.tree.nodes.some((n) => n.type === "Button")).toBe(true);
  });

  /**
   * How the map gets filled in: from what a file actually uses, in usage order,
   * rather than from someone enumerating a design system up front.
   */
  it("reports each undeclared component once, with the key to map", () => {
    const notes = compile(frame({ name: "Primary CTA" }), { theme, surfaces }).notes.filter(
      (n) => n.kind === "unmapped-component",
    );
    expect(notes.map((n) => n.irId)).toContain(KEY);
    expect(notes.find((n) => n.irId === KEY)?.message).toContain("Primary CTA");
  });

  it("collapses the whole instance into one Button", () => {
    const b = buttonOf({ [KEY]: "Button" })!;
    expect(b.props.label).toBe("VIEW MORE");
    // The label, the glyph and both wrapper frames are all inputs to it.
    for (const gone of ["2:2", "2:3", "2:4"]) {
      expect(compiled({ [KEY]: "Button" }).tree.nodes.some((n) => n.src === gone)).toBe(false);
    }
  });

  /**
   * The name says WHAT, the token binding says WHICH. Encode the variant in the
   * name instead and it lies the moment a designer switches one instance.
   */
  it("takes variant and style from the token family, not the name", () => {
    expect(buttonOf({ [KEY]: "Button" })?.props).toMatchObject({
      variant: "outline",
      styleN: 2,
    });
  });

  it("follows the binding to a different family", () => {
    const doc = frame({ paint: "button/filled/style_3/text/default" });
    const b = compile(doc, { theme, surfaces, primitives: { [KEY]: "Button" } }).tree.nodes.find(
      (n) => n.type === "Button",
    );
    expect(b?.props).toMatchObject({ variant: "filled", styleN: 3 });
  });

  it("takes size from the label's type token and padding from the drawn box", () => {
    expect(buttonOf({ [KEY]: "Button" })?.props).toMatchObject({
      size: "sm",
      space: { px: "space.4", py: "space.1_5" },
    });
  });

  /** `atom_icon_arrow_up_right` — the prefix is the marker, not the glyph. */
  it("strips the naming convention off the glyph reference", () => {
    expect(buttonOf({ [KEY]: "Button" })?.props.iconEnd).toBe("arrow_up_right");
  });

  /**
   * Where a button goes is not in the design. Inventing an href is the same
   * class of mistake as inventing a data model.
   */
  it("does not invent an action", () => {
    expect(buttonOf({ [KEY]: "Button" })?.props.action).toEqual({ kind: "none" });
  });

  it("falls back to frames when a declared Button has no label", () => {
    const doc = frame({ label: null });
    const result = compile(doc, { theme, surfaces, primitives: { [KEY]: "Button" } });
    expect(result.tree.nodes.some((n) => n.type === "Button")).toBe(false);
    expect(result.notes.some((n) => n.message.includes("not a button"))).toBe(true);
  });

  it("still emits a legal tree", () => {
    const result = compiled({ [KEY]: "Button" });
    const merged = {
      assets: surfaces.assets,
      surfaces: new Map([
        ...surfaces.surfaces,
        ...result.requiredSurfaces.map((r) => [r.name, r.spec] as const),
      ]),
    };
    const report = validate(result.tree, { registry: createRegistry(theme, { surfaces: merged }) });
    expect(report.errors).toEqual([]);
    expect(() => reify(flatTreeSchema.parse(result.tree))).not.toThrow();
  });
});

/**
 * The line clamp, which decides how tall a card is.
 *
 * A news section whose six body texts each hold 474 characters in a two-line
 * box compiled without any clamp: every card grew to fit its copy, the 444px
 * band rendered 837px tall, and the root's own `clip` cut the design in half.
 * The clamp was in Figma the whole time — under `textTruncation`, which nothing
 * read, because `autoResize` says `HEIGHT` on a clamped layer exactly as it
 * does on a flowing one.
 */
describe("text truncation", () => {
  const at = (x: number, y: number, w: number, h: number) => ({
    bbox: { x, y, w, h },
    relBbox: { x, y, w, h },
    rotation: 0,
    aspect: w / (h || 1),
    aspectBucket: "wide" as const,
  });
  const layout = {
    mode: "vertical" as const,
    gap: null,
    padding: {
      top: { value: 0, unbound: false },
      right: { value: 0, unbound: false },
      bottom: { value: 0, unbound: false },
      left: { value: 0, unbound: false },
    },
    align: "MIN" as const,
    justify: "MIN" as const,
    wrap: false,
    sizing: { w: "fixed" as const, h: "hug" as const },
    positioning: "auto" as const,
  };
  const base = {
    layout,
    fill: null,
    stroke: null,
    radius: null,
    effects: [],
    opacity: 1,
    clipsContent: false,
    structuralSignature: "s",
    canonicalSignature: "c",
    repeatedSiblings: 1,
    depth: 1,
    childCount: 0,
    children: [],
  };

  /** One text layer, however Figma happens to describe its clamp. */
  function withText(text: Record<string, unknown>, version = "1.7.0") {
    return parseFrameIRDocument({
      fileKey: "t",
      fileName: "t",
      pageName: "p",
      rootNodeId: "1:1",
      extractedAt: "2026-01-01T00:00:00.000Z",
      irVersion: version,
      breakpointHint: 379,
      root: {
        ...base,
        id: "1:1",
        name: "Card",
        type: "FRAME",
        geometry: at(0, 0, 379, 200),
        depth: 0,
        childCount: 1,
        children: [
          {
            ...base,
            id: "1:2",
            name: "Body",
            type: "TEXT",
            geometry: at(0, 0, 379, 44),
            text: {
              characters: "James Vince stroked 60 from 38 and Chris Jordan produced a late cameo",
              styleRef: "body_sm/medium",
              unbound: false,
              fontSize: 12,
              fontFamily: "Montserrat",
              fontWeight: 500,
              lineHeight: 18,
              lines: 2,
              ...text,
            },
          },
        ],
      },
    });
  }

  const truncateOf = (doc: ReturnType<typeof withText>) =>
    compile(doc, { theme, surfaces }).tree.nodes.find((n) => n.src === "1:2")?.props.truncate;

  it("clamps at maxLines when the designer pinned one", () => {
    expect(truncateOf(withText({ autoResize: "HEIGHT", truncation: "ENDING", maxLines: 3 }))).toBe(3);
  });

  /** Figma's null maxLines means "as many as fit", and the box says how many. */
  it("falls back to the line count the box implies", () => {
    expect(truncateOf(withText({ autoResize: "HEIGHT", truncation: "ENDING" }))).toBe(2);
  });

  it("still honours the older TRUNCATE mode", () => {
    expect(truncateOf(withText({ autoResize: "TRUNCATE" }))).toBe(2);
  });

  /**
   * The guarantee that makes this safe to ship: a document that predates 1.7.0
   * cannot say whether a text is clamped, so nothing is inferred. Clamping a
   * text merely because its content looks too big for its box would put a
   * permanent ellipsis on every paragraph in every design compiled so far.
   */
  it("infers nothing from geometry when Figma has not said", () => {
    expect(truncateOf(withText({ autoResize: "HEIGHT" }, "1.6.0"))).toBeUndefined();
    expect(truncateOf(withText({ autoResize: "WIDTH_AND_HEIGHT" }, "1.6.0"))).toBeUndefined();
  });
});

/**
 * Full-width bands, which are the whole reason a desktop design has a width at
 * all.
 *
 * A live strip drawn on a 1366 artboard is not 1366 wide, it is page-wide, and
 * compiling its artboard number left a white gutter on every larger desktop
 * with the call to action stranded 550px short of the edge. Three rules undo
 * that, and each is only allowed to fire where it changes nothing at the design
 * width — which is what the last test here checks.
 */
describe("full-width bands", () => {
  const pad = (v = 0) => ({
    top: { value: v, unbound: false },
    right: { value: v, unbound: false },
    bottom: { value: v, unbound: false },
    left: { value: v, unbound: false },
  });
  const at = (x: number, y: number, w: number, h: number) => ({
    bbox: { x, y, w, h },
    relBbox: { x, y, w, h },
    rotation: 0,
    aspect: w / (h || 1),
    aspectBucket: "wide" as const,
  });
  const base = {
    fill: null,
    stroke: null,
    radius: null,
    effects: [],
    opacity: 1,
    clipsContent: false,
    structuralSignature: "s",
    canonicalSignature: "c",
    repeatedSiblings: 1,
    depth: 1,
    childCount: 0,
    children: [],
  };
  const absolute = {
    mode: "none" as const,
    gap: null,
    padding: pad(),
    align: null,
    justify: null,
    wrap: false,
    sizing: { w: "fixed" as const, h: "fixed" as const },
    positioning: "auto" as const,
  };
  const row = (justify: "MIN" | "SPACE_BETWEEN" = "MIN") => ({
    mode: "horizontal" as const,
    gap: { value: 20, tokenRef: "Spacing/spacing_5", unbound: false },
    padding: pad(),
    align: "CENTER" as const,
    justify,
    wrap: false,
    sizing: { w: "fixed" as const, h: "hug" as const },
    positioning: "auto" as const,
  });

  /**
   * A band with one content row, shaped like the live strip: the row sits
   * 41.72 from the left with 20.35 to spare on the right, and its own children
   * run edge to edge inside it.
   */
  function band(
    over: {
      width?: number;
      rowX?: number;
      rowW?: number;
      lastChildW?: number;
      /** Space the design left after the last child, inside the row. */
      slack?: number;
      children?: number;
    } = {},
  ) {
    const width = over.width ?? 1366;
    const rowX = over.rowX ?? 41.72;
    const rowW = over.rowW ?? 1303.93;
    const lastW = over.lastChildW ?? 400;
    const slack = over.slack ?? 0;
    const count = over.children ?? 2;

    const kids = [
      { ...base, id: "2:1", name: "Score", type: "FRAME" as const, layout: row(), geometry: at(0, 0, 300, 40) },
      {
        ...base,
        id: "2:2",
        name: "Actions",
        type: "FRAME" as const,
        layout: row(),
        geometry: at(rowW - lastW - slack, 0, lastW, 40),
      },
    ].slice(0, count);

    return parseFrameIRDocument({
      fileKey: "t",
      fileName: "t",
      pageName: "p",
      rootNodeId: "1:1",
      extractedAt: "2026-01-01T00:00:00.000Z",
      irVersion: "1.6.0",
      breakpointHint: width,
      root: {
        ...base,
        id: "1:1",
        name: "Live",
        type: "FRAME",
        layout: absolute,
        geometry: at(0, 0, width, 67),
        depth: 0,
        childCount: 1,
        children: [
          {
            ...base,
            id: "1:2",
            name: "Row",
            type: "FRAME",
            layout: row(),
            geometry: at(rowX, 8, rowW, 52),
            childCount: kids.length,
            children: kids,
          },
        ],
      },
    });
  }

  const rootOfBand = (doc: ReturnType<typeof band>) =>
    compile(doc, { theme, surfaces }).tree.nodes.find((n) => n.parent === null)!;
  const rowOf = (doc: ReturnType<typeof band>) =>
    compile(doc, { theme, surfaces }).tree.nodes.find((n) => n.src === "1:2")!;

  it("fills the viewport instead of the artboard it was drawn on", () => {
    expect((rootOfBand(band()).props.size as { w: unknown }).w).toBe("full");
  });

  /**
   * The rule has to keep its hands off objects. A player card is 281px wide
   * wherever it lands, and a card that grew to fill the page would be a far
   * worse bug than the gutter this fixes.
   */
  it("leaves a frame narrower than a desktop breakpoint pinned", () => {
    const w = (rootOfBand(band({ width: 900, rowW: 860 })).props.size as { w: { raw: number } }).w;
    expect(w.raw).toBe(900);
  });

  it("stretches the content row and carries its side gaps as padding", () => {
    const emitted = rowOf(band());

    expect(emitted.props.place).toEqual({
      anchor: "top-fill",
      offset: { block: { raw: 8, _unbound: true } },
    });
    // `width` alongside both insets would over-constrain the box, and CSS
    // resolves that by dropping the end inset — the pin all over again.
    expect((emitted.props.size as { w?: unknown }).w).toBeUndefined();
    expect(emitted.props.space).toEqual({
      pl: { raw: 41.72, _unbound: true },
      pr: { raw: 20.35, _unbound: true },
    });
  });

  /**
   * The row's children reached both its edges at 1366, and `justify: start`
   * only reproduces that while the row is exactly as wide as they are.
   */
  it("distributes the free space a wider viewport adds", () => {
    expect(rowOf(band()).props.justify).toBe("between");
  });

  it("leaves a row whose children stop short packed at the start", () => {
    // The row still spans the band and still stretches — but 200px of empty
    // row after the last child is a gap the design asked for, and spreading
    // the children into it would be a relayout.
    const stretched = rowOf(band({ slack: 200 }));
    expect((stretched.props.place as { anchor: string }).anchor).toBe("top-fill");
    expect(stretched.props.justify).toBe("start");
  });

  it("leaves a single-child row alone — there is nothing to distribute", () => {
    expect(rowOf(band({ children: 1 })).props.justify).toBe("start");
  });

  /**
   * Something positioned INSIDE a band is not its content row. A badge moved to
   * the page edge is a relayout, not a de-pinning.
   */
  it("leaves a child that does not span the band where the IR put it", () => {
    const badge = band({ rowX: 41.72, rowW: 300 });
    const emitted = rowOf(badge);
    expect((emitted.props.place as { anchor: string }).anchor).toBe("top-start");
    expect((emitted.props.size as { w: { raw: number } }).w.raw).toBe(300);
  });

  it("says what it did, so a surprising layout is attributable", () => {
    const kinds = compile(band(), { theme, surfaces })
      .notes.filter((n) => n.kind === "fluid-band")
      .map((n) => n.nodeId);
    // One for the band, one for the stretched row, one for the distribution.
    expect(kinds.length).toBe(3);
  });

  it("still emits a legal tree", () => {
    const result = compile(band(), { theme, surfaces });
    const merged = {
      assets: surfaces.assets,
      surfaces: new Map([
        ...surfaces.surfaces,
        ...result.requiredSurfaces.map((r) => [r.name, r.spec] as const),
      ]),
    };
    const report = validate(result.tree, {
      registry: createRegistry(theme, { surfaces: merged }),
    });
    expect(report.errors).toEqual([]);
    expect(() => reify(flatTreeSchema.parse(result.tree))).not.toThrow();
  });
});

/**
 * Composite backgrounds: several layers, one bitmap.
 *
 * The fixtures header is a gradient plate, a wave texture, a diagonal facet and
 * a white cutout. Before a mark could hold more than one source there was no
 * way to say that, so each layer was either marked separately — four assets
 * painting over each other — or not at all, and the unmarked ones came out as
 * boxes and placeholders stacked on top of the picture.
 */