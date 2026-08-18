/**
 * The gate has to be guarded harder than what it guards.
 *
 * A check that silently stops firing is worse than no check, because the green
 * build now means nothing. So every case here breaks something real and asserts
 * the SPECIFIC code comes back — not merely that something failed.
 *
 * The mutations are the actual bugs from building the first five examples:
 * a dropped node, a hardcoded px where Figma says hug, a raw that is already a
 * token, a duplicated src, a box in the wrong place.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatTreeSchema, type FlatTree } from "@fanos/dsl";
import { loadTheme } from "@fanos/tokens";
import { parseFrameIRDocument, type FrameIRDocument } from "@fanos/surface-canvas/ir";
import { conform } from "../src/conform.js";
import { issuesByCode } from "../src/issues.js";
import { sliceIr } from "../src/slice.js";

const dir = new URL("../fixtures/ir/", import.meta.url).pathname;
const treeDir = new URL("../../dsl/fixtures/", import.meta.url).pathname;
const THEME = new URL("../../tokens/fixtures/southern-brave.json", import.meta.url).pathname;

const theme = loadTheme(THEME);
const ir = (name: string): FrameIRDocument =>
  parseFrameIRDocument(JSON.parse(readFileSync(`${dir}${name}.ir.json`, "utf8")));
const tree = (name: string): FlatTree =>
  flatTreeSchema.parse(JSON.parse(readFileSync(`${treeDir}${name}.json`, "utf8")));

const codes = (r: ReturnType<typeof conform>) => Object.keys(issuesByCode(r.errors)).sort();
const nodeOf = (t: FlatTree, id: string) => {
  const n = t.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node "${id}"`);
  return n;
};

const FIXTURES = [
  "player-card",
  "news-card",
  "videos-section",
  "fixture-card",
  "newsletter-signup",
] as const;

describe("the shipped fixtures conform to their IR", () => {
  for (const name of FIXTURES) {
    it(`${name} has zero conformance errors`, () => {
      const r = conform(tree(name), ir(name), { theme });
      expect(r.errors.map((e) => `${e.code} ${e.nodeId ?? e.irId}`)).toEqual([]);
    });
  }
});

describe("C1 — coverage", () => {
  it("fires when a subtree is dropped", () => {
    // The exact bug that lost the fixture card's date strip: start the tree one
    // level too deep and everything above it silently disappears.
    const t = tree("fixture-card");
    t.nodes = t.nodes.filter((n) => n.id !== "date_text");
    const r = conform(t, ir("fixture-card"), { theme });
    expect(codes(r)).toContain("C1");
    expect(r.summary.coverage.missing).toBeGreaterThan(0);
  });

  it("does NOT fire for a leaf that absorbs its own vectors", () => {
    // An Icon stands for the path inside it; a ":" Text for six 2x2 ellipses.
    const r = conform(tree("fixture-card"), ir("fixture-card"), { theme });
    expect(r.summary.coverage.absorbed).toBeGreaterThan(0);
    expect(r.summary.coverage.missing).toBe(0);
  });

  it("counts a Repeater's other instances as covered, not missing", () => {
    const r = conform(tree("fixture-card"), ir("fixture-card"), { theme });
    expect(r.summary.coverage.repeated).toBeGreaterThan(0);
  });

  it("attributes a missing node to its nearest represented ancestor", () => {
    const t = tree("fixture-card");
    t.nodes = t.nodes.filter((n) => n.id !== "date_text");
    const r = conform(t, ir("fixture-card"), { theme });
    const c1 = r.errors.filter((e) => e.code === "C1");
    // Without an owner the finding is unfixable and unwaivable.
    expect(c1.every((e) => e.nodeId !== undefined)).toBe(true);
  });
});

describe("C3 — sizing authority", () => {
  it("fires on a hardcoded px where the IR says hug or fill", () => {
    const t = tree("newsletter-signup");
    nodeOf(t, "form").props.size = { w: { raw: 515, _unbound: true } };
    const r = conform(t, ir("newsletter-signup"), { theme });
    expect(codes(r)).toContain("C3");
    expect(r.errors.find((e) => e.code === "C3")?.message).toContain("hug");
  });

  it("accepts a px where the IR genuinely says fixed", () => {
    // The 509x52 input plate IS fixed in Figma; C3 must not nag about it.
    const r = conform(tree("newsletter-signup"), ir("newsletter-signup"), { theme });
    expect(r.errors.filter((e) => e.code === "C3")).toEqual([]);
  });
});

describe("C4 — token snapping", () => {
  it("errors on a gap that exactly equals a space token", () => {
    const t = tree("fixture-card");
    nodeOf(t, "teams").props.gap = { raw: 4, _unbound: true };
    const r = conform(t, ir("fixture-card"), { theme });
    const c4 = r.errors.filter((e) => e.code === "C4");
    expect(c4).toHaveLength(1);
    expect(c4[0]!.message).toContain("space.1");
  });

  it("only warns on a width that coincides with a token", () => {
    // A 20px checkbox is not a spacing value just because space.5 is 20.
    const r = conform(tree("newsletter-signup"), ir("newsletter-signup"), { theme });
    expect(r.warnings.some((w) => w.code === "C4" && w.nodeId === "consent_box")).toBe(true);
    expect(r.errors.some((e) => e.code === "C4")).toBe(false);
  });

  it("ignores offsets — a position landing on the scale is a coincidence", () => {
    const t = tree("player-card");
    nodeOf(t, "cutout").props.place = {
      anchor: "top-center",
      offset: { block: { raw: 16, _unbound: true } },
    };
    const r = conform(t, ir("player-card"), { theme });
    expect(r.errors.some((e) => e.code === "C4" && e.nodeId === "cutout")).toBe(false);
  });
});

describe("C5 — src", () => {
  it("fires on a duplicated src", () => {
    const t = tree("videos-section");
    nodeOf(t, "caption_date").src = nodeOf(t, "caption_title").src;
    const r = conform(t, ir("videos-section"), { theme });
    expect(codes(r)).toContain("C5");
  });

  it("fires on a src that is not in this IR document", () => {
    const t = tree("videos-section");
    nodeOf(t, "caption_date").src = "9:9999";
    const r = conform(t, ir("videos-section"), { theme });
    expect(r.errors.some((e) => e.code === "C5" && e.message.includes("not in this IR"))).toBe(true);
  });

  it("accepts a synthetic src that points at a real node", () => {
    const r = conform(tree("fixture-card"), ir("fixture-card"), { theme });
    expect(r.errors.filter((e) => e.code === "C5")).toEqual([]);
  });
});

/**
 * Perfect boxes, synthesised from the IR, so a test exercises the comparison
 * rather than the browser. Shared with the deviation suite, which needs an
 * otherwise-clean render to put one deliberate departure into.
 */
const boxesFor = (t: FlatTree, doc: FrameIRDocument) => {
  const index = new Map<string, { x: number; y: number; w: number; h: number }>();
  const walk = (n: FrameIRDocument["root"], x: number, y: number): void => {
    const abs = { x: x + n.geometry.relBbox.x, y: y + n.geometry.relBbox.y };
    index.set(n.id, { ...abs, w: n.geometry.relBbox.w, h: n.geometry.relBbox.h });
    for (const c of n.children ?? []) walk(c, abs.x, abs.y);
  };
  walk(doc.root, -doc.root.geometry.relBbox.x, -doc.root.geometry.relBbox.y);
  return t.nodes.filter((n) => index.has(n.src)).map((n) => ({ id: n.id, ...index.get(n.src)! }));
};

describe("C2 — geometry", () => {
  it("passes when every box matches the IR", () => {
    const t = tree("newsletter-signup");
    const doc = ir("newsletter-signup");
    const r = conform(t, doc, { theme, boxes: boxesFor(t, doc), only: ["C2"] });
    expect(r.errors).toEqual([]);
    expect(r.summary.geometry.compared).toBeGreaterThan(5);
  });

  it("fires when a node renders at the wrong size", () => {
    const t = tree("newsletter-signup");
    const doc = ir("newsletter-signup");
    const boxes = boxesFor(t, doc).map((b) => (b.id === "field" ? { ...b, h: b.h + 8 } : b));
    const r = conform(t, doc, { theme, boxes, only: ["C2"] });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.nodeId).toBe("field");
    expect(r.errors[0]!.message).toContain("h ");
  });

  it("tolerates sub-pixel drift", () => {
    const t = tree("newsletter-signup");
    const doc = ir("newsletter-signup");
    const boxes = boxesFor(t, doc).map((b) => ({ ...b, x: b.x + 0.4, y: b.y - 0.3 }));
    const r = conform(t, doc, { theme, boxes, only: ["C2"] });
    expect(r.errors).toEqual([]);
  });

  it("divides by the render scale, so a 2x card still compares to native", () => {
    const t = tree("newsletter-signup");
    const doc = ir("newsletter-signup");
    const boxes = boxesFor(t, doc).map((b) => ({
      id: b.id,
      x: b.x * 2,
      y: b.y * 2,
      w: b.w * 2,
      h: b.h * 2,
    }));
    const r = conform(t, doc, { theme, boxes, only: ["C2"], geometry: { scale: 2 } });
    expect(r.errors).toEqual([]);
  });
});

describe("_meta.deviations", () => {
  it("downgrades a declared failure to info, keeping the reason", () => {
    const r = conform(tree("player-card"), ir("player-card"), { theme });
    expect(r.ok).toBe(true);
    expect(r.summary.waived).toBeGreaterThan(0);
    expect(r.infos.some((i) => i.waived?.includes("texture.card_bg"))).toBe(true);
  });

  it("stops covering once the declared max is exceeded", () => {
    // The point of the budget: the waiver excuses KNOWN missing art, not the
    // next thing to go missing.
    const t = tree("player-card");
    const card = nodeOf(t, "card");
    (card.props._meta as { deviations: { max: number }[] }).deviations[0]!.max = 2;
    const r = conform(t, ir("player-card"), { theme });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes("past the declared max"))).toBe(true);
  });

  /**
   * A waived box is not error magnitude.
   *
   * `totalDelta` is the number a reader watches to tell whether a tree is
   * getting better, and the compiler now produces boxes that depart from the IR
   * on purpose — a band's content row is stretched to follow its fluid parent,
   * with the old offset carried as padding, so the row's box is the band's and
   * every descendant is still where Figma put it. Counting that departure would
   * report a large and permanent regression for a layout nobody is meant to fix.
   */
  it("takes a waived geometry failure back out of the totals", () => {
    const t = tree("newsletter-signup");
    const doc = ir("newsletter-signup");
    // One node stretched past its IR box, the way a band's content row is.
    const boxes = boxesFor(t, doc).map((b) =>
      b.id === "copy" ? { ...b, x: b.x - 40, w: b.w + 60 } : b,
    );

    const before = conform(t, doc, { theme, boxes, only: ["C2"] });
    expect(before.errors.map((e) => e.nodeId)).toEqual(["copy"]);
    expect(before.summary.geometry.totalDelta).toBeGreaterThan(50);

    nodeOf(t, "copy").props._meta = {
      deviations: [{ check: "C2", reason: "stretched to follow a fluid parent", max: 1 }],
    };
    const after = conform(t, doc, { theme, boxes, only: ["C2"] });
    expect(after.ok).toBe(true);
    expect(after.summary.waived).toBe(1);
    expect(after.summary.geometry.totalDelta).toBe(0);
    expect(after.summary.geometry.worstDelta).toBe(0);
    // Still reported, with the reason attached — waived, not hidden.
    expect(after.infos.some((i) => i.code === "C2" && i.nodeId === "copy")).toBe(true);
  });

  it("waives only the check it names", () => {
    const t = tree("player-card");
    nodeOf(t, "stats").props.gap = { raw: 13, _unbound: true };
    nodeOf(t, "stats").props.space = { px: "space.5", py: { raw: 10, _unbound: true } };
    const r = conform(t, ir("player-card"), { theme });
    // C1 is waived on other nodes; this C4 is not.
    expect(r.errors.some((e) => e.code === "C4" && e.nodeId === "stats")).toBe(true);
  });
});

describe("sliceIr", () => {
  it("re-roots a subtree and zeroes the root's parent offset", () => {
    const page = ir("photos-page");
    const sliced = sliceIr(page, "88:5760");
    expect(sliced).toBeDefined();
    expect(sliced!.rootNodeId).toBe("88:5760");
    expect(sliced!.root.geometry.relBbox.x).toBe(0);
    expect(sliced!.root.geometry.relBbox.y).toBe(0);
    // The page-absolute bbox is untouched — it is still true.
    expect(sliced!.root.geometry.bbox).toEqual(page.root.children[1]!.geometry.bbox);
  });

  it("returns undefined for a node that is not in the document", () => {
    expect(sliceIr(ir("photos-page"), "1:5093")).toBeUndefined();
  });
});

/**
 * Position comes from the difference of two absolute boxes, not from summing
 * `relBbox` up the ancestry.
 *
 * `relBbox` is the pre-rotation box, so a quarter-turned node contributed its
 * unrotated origin and C2 reported a 552px x-error on hairlines that were
 * exactly where they belonged. Summing also accumulated every ancestor's
 * rounding, so depth alone produced drift.
 */
describe("C2 — frame-local position", () => {
  /**
   * A rule laid flat: `bbox` (post-rotation, on screen) says it starts at
   * x=16, `relBbox` (pre-rotation) says x=568. Only one of those is where the
   * browser will draw it.
   */
  const rotatedDoc = (): FrameIRDocument =>
    parseFrameIRDocument({
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
          bbox: { x: 100, y: 200, w: 552, h: 100 },
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
            type: "VECTOR",
            layout: {
              mode: "none",
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
              sizing: { w: "fill", h: "fixed" },
              positioning: "auto",
            },
            geometry: {
              // on screen: 16px from the frame's left edge, 552 wide, 1 tall
              bbox: { x: 116, y: 240, w: 552, h: 1 },
              // pre-rotation: a 1x552 vertical rule sitting at x=568
              relBbox: { x: 568, y: 40, w: 1, h: 552 },
              rotation: 90,
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
    });

  const treeFor = (): FlatTree =>
    flatTreeSchema.parse({
      schemaVersion: "1.0.0",
      nodes: [
        {
          id: "root",
          parent: null,
          idx: 0,
          type: "Stack",
          src: "1:1",
          props: { size: { w: { raw: 552, _unbound: true }, h: "auto" } },
        },
        {
          id: "rule",
          parent: "root",
          idx: 0,
          type: "Divider",
          src: "1:2",
          props: { orientation: "horizontal" },
        },
      ],
    });

  it("compares against where the node actually lands, not its unrotated origin", () => {
    const doc = rotatedDoc();
    // Exactly the on-screen box, frame-local: bbox minus the root's bbox.
    const boxes = [
      { id: "root", x: 0, y: 0, w: 552, h: 100 },
      { id: "rule", x: 16, y: 40, w: 552, h: 1 },
    ];
    const r = conform(treeFor(), doc, { theme, boxes, rootSrc: "1:1", only: ["C2"] });
    expect(r.errors).toEqual([]);
  });

  it("still fires when a rotated node is genuinely misplaced", () => {
    const doc = rotatedDoc();
    const boxes = [
      { id: "root", x: 0, y: 0, w: 552, h: 100 },
      { id: "rule", x: 60, y: 40, w: 552, h: 1 },
    ];
    const r = conform(treeFor(), doc, { theme, boxes, rootSrc: "1:1", only: ["C2"] });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toContain("x ");
  });
});

/**
 * The count is the number that does NOT move.
 *
 * Fixing the rotated-position bug removed 8,365px of error across this page and
 * changed the error count by zero — a 262px container collapse and a 2px
 * rounding difference each count as exactly one. Magnitude is what tracks work.
 */
describe("C2 — drift magnitude", () => {
  const boxesFor = (t: FlatTree, doc: FrameIRDocument) => {
    const index = new Map<string, { x: number; y: number; w: number; h: number }>();
    const walk = (n: FrameIRDocument["root"], x: number, y: number): void => {
      const abs = { x: x + n.geometry.relBbox.x, y: y + n.geometry.relBbox.y };
      index.set(n.id, { ...abs, w: n.geometry.relBbox.w, h: n.geometry.relBbox.h });
      for (const c of n.children ?? []) walk(c, abs.x, abs.y);
    };
    walk(doc.root, -doc.root.geometry.relBbox.x, -doc.root.geometry.relBbox.y);
    return t.nodes.filter((n) => index.has(n.src)).map((n) => ({ id: n.id, ...index.get(n.src)! }));
  };

  it("is zero when everything matches", () => {
    const t = tree("newsletter-signup");
    const doc = ir("newsletter-signup");
    const r = conform(t, doc, { theme, boxes: boxesFor(t, doc), only: ["C2"] });
    expect(r.summary.geometry.totalDelta).toBe(0);
  });

  it("counts a node once, by its worst axis", () => {
    const t = tree("newsletter-signup");
    const doc = ir("newsletter-signup");
    // Off on all four axes; the worst is 40, so it must contribute 40, not 100.
    const boxes = boxesFor(t, doc).map((b) =>
      b.id === "field" ? { x: b.x + 10, y: b.y + 20, w: b.w + 30, h: b.h + 40, id: b.id } : b,
    );
    const r = conform(t, doc, { theme, boxes, only: ["C2"] });
    expect(r.errors).toHaveLength(1);
    expect(r.summary.geometry.totalDelta).toBe(40);
  });

  /** Two nodes each 20px out is worse than one, and the total has to say so. */
  it("separates two small errors from one large one, which the count cannot", () => {
    const t = tree("newsletter-signup");
    const doc = ir("newsletter-signup");
    const ids = boxesFor(t, doc).slice(0, 2).map((b) => b.id);

    const spread = boxesFor(t, doc).map((b) =>
      ids.includes(b.id) ? { ...b, h: b.h + 20 } : b,
    );
    const concentrated = boxesFor(t, doc).map((b) =>
      b.id === ids[0] ? { ...b, h: b.h + 200 } : b,
    );

    const a = conform(t, doc, { theme, boxes: spread, only: ["C2"] });
    const c = conform(t, doc, { theme, boxes: concentrated, only: ["C2"] });

    expect(a.errors.length).toBeGreaterThan(c.errors.length);
    expect(a.summary.geometry.totalDelta).toBeLessThan(c.summary.geometry.totalDelta);
  });
});
