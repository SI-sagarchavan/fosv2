/**
 * The two post-emission cleanups, and the reason each one exists.
 *
 * Every number asserted here was measured on `fixtures/news-grid.ir.json` —
 * the real Southern Brave "SOUTH COAST STORIES" section — rather than chosen.
 * When one of them changes, the question to ask is which pass changed and
 * whether the tree is truer for it, not which number to edit.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRegistry, loadSurfaces, loadTheme } from "@fanos/tokens";
import { analyze, validate, type FlatNode } from "@fanos/dsl";
import { parseFrameIRDocument } from "@fanos/surface-canvas/ir";
import { compile } from "../src/compile.js";
import { dropRedundantCrop, dropZeroValues } from "../src/cleanup.js";

const THEME = new URL("../../tokens/fixtures/southern-brave.json", import.meta.url).pathname;
const SURFACES = new URL("../../tokens/surfaces/southern-brave.json", import.meta.url).pathname;
const IR = new URL("../fixtures/news-grid.ir.json", import.meta.url).pathname;

const theme = loadTheme(THEME);
const surfaces = loadSurfaces(SURFACES);
const doc = () => parseFrameIRDocument(JSON.parse(readFileSync(IR, "utf8")));

const build = (options?: Parameters<typeof compile>[1]["cleanup"]) =>
  compile(doc(), { theme, surfaces, ...(options ? { cleanup: options } : {}) });

const registry = () => createRegistry(theme, { surfaces: loadSurfaces(SURFACES) });

describe("news-grid: the whole pass", () => {
  it("still validates after both cleanups", () => {
    const result = build();
    const check = validate(result.tree, { registry: registry() });
    expect(check.errors.map((e) => `${e.code} ${e.nodeId ?? ""} ${e.path ?? ""}`)).toEqual([]);
    expect(check.warnings).toEqual([]);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(build().tree)).toBe(JSON.stringify(build().tree));
  });

  it("reports what it removed", () => {
    expect(build().stats.cleanup).toEqual({ cropsDropped: 6, rawsDropped: 24, zeroProps: 29 });
  });
});

describe("1 — redundant image crop geometry", () => {
  it("takes the pre-crop box off all six images", () => {
    const images = build().tree.nodes.filter((n) => n.type === "Image");
    expect(images).toHaveLength(6);
    for (const image of images) {
      expect(image.props.size).toBeUndefined();
      expect(image.props.place).toEqual({ anchor: "fill" });
    }
  });

  /**
   * Measured against the same tree with only this pass turned off, so nothing
   * else can flatter or spoil it. Four per image: two offsets and two
   * dimensions.
   */
  it("drops exactly 24 raw values, and nothing else does", () => {
    const withCrop = analyze(build().tree).rawValueCount.total;
    const withoutCrop = analyze(build({ crop: false }).tree).rawValueCount.total;
    expect(withoutCrop - withCrop).toBe(24);
    expect(build().stats.cleanup.rawsDropped).toBe(24);
  });

  /**
   * The player-card regression.
   *
   * A `contain` cutout is placed where the designer dragged it. Stripping its
   * box would centre a silhouette that was deliberately off-centre, and the
   * bug would only ever show up as a picture nobody could explain.
   */
  it("keeps place and size when fit is contain", () => {
    const nodes = cutout("contain");
    const [, image] = dropRedundantCrop(nodes, []).nodes;
    expect(image!.props.place).toEqual({ anchor: "top-start", offset: { block: raw(-40) } });
    expect(image!.props.size).toEqual({ w: raw(400) });
  });

  it("keeps place and size when fit is none", () => {
    const [, image] = dropRedundantCrop(cutout("none"), []).nodes;
    expect(image!.props.size).toEqual({ w: raw(400) });
  });

  it("keeps them when the parent does not clip — nothing is being cropped", () => {
    const nodes = cutout("cover");
    nodes[0]!.props = {};
    const [, image] = dropRedundantCrop(nodes, []).nodes;
    expect(image!.props.size).toEqual({ w: raw(400) });
  });

  it("keeps them when the image has a sibling — the offsets are layering", () => {
    const nodes = [
      ...cutout("cover"),
      { id: "badge", parent: "frame", idx: 1, type: "Tag", src: "1:3", props: {} } as FlatNode,
    ];
    const image = dropRedundantCrop(nodes, []).nodes.find((n) => n.id === "image");
    expect(image!.props.size).toEqual({ w: raw(400) });
  });

  /**
   * The picture is the same; the rectangle is not. C2 compares the rendered box
   * against the IR's, and the IR's box for a cropped image is the oversized
   * bitmap Figma positions to make the crop. Without the waiver this pass turns
   * six clean images into six geometry failures.
   */
  it("declares the box change so the fidelity gate can account for it", () => {
    for (const image of build().tree.nodes.filter((n) => n.type === "Image")) {
      const deviations = (image.props._meta as { deviations: { check: string; max: number }[] }).deviations;
      expect(deviations).toHaveLength(1);
      expect(deviations[0]).toMatchObject({ check: "C2", max: 1 });
    }
  });

  it("drops place entirely under a parent that cannot anchor a child", () => {
    const nodes = cutout("cover");
    nodes[0]!.type = "Box";
    const image = dropRedundantCrop(nodes, []).nodes.find((n) => n.id === "image");
    expect(image!.props.place).toBeUndefined();
    expect(image!.props.size).toBeUndefined();
  });
});

describe("2 — zero-valued props", () => {
  it("removes 29 of them from the news grid", () => {
    expect(build().stats.cleanup.zeroProps).toBe(29);
    const withZeros = build({ zeros: false }).tree;
    expect(countZeroes(withZeros.nodes)).toBe(29);
    expect(countZeroes(build().tree.nodes)).toBe(0);
  });

  it("drops the object a zero leaves empty", () => {
    const nodes: FlatNode[] = [
      { id: "a", parent: null, idx: 0, type: "Stack", src: "1:1", props: { gap: "space.0", space: { p: "space.0" } } },
    ];
    expect(dropZeroValues(nodes, []).nodes[0]!.props).toEqual({});
  });

  /**
   * Zero is only meaningless where the renderer's default is zero. An opacity
   * token of 0 means invisible and a 0-wide box is a degenerate box; deleting
   * either changes the picture rather than tidying the tree.
   */
  it("leaves zeroes that mean something alone", () => {
    const nodes: FlatNode[] = [
      { id: "a", parent: null, idx: 0, type: "Divider", src: "1:1", props: { orientation: "horizontal", opacity: "opacity.0" } },
      { id: "b", parent: "a", idx: 0, type: "Box", src: "1:2", props: { size: { w: raw(0) }, truncate: 0 } },
    ];
    const out = dropZeroValues(nodes, []).nodes;
    expect(out[0]!.props.opacity).toBe("opacity.0");
    expect(out[1]!.props.size).toEqual({ w: raw(0) });
  });

  it("never touches _meta — a waiver's bound is a count, not padding", () => {
    const nodes: FlatNode[] = [
      { id: "a", parent: null, idx: 0, type: "Box", src: "1:1", props: { _meta: { deviations: [{ check: "C2", reason: "x", max: 0 }] } } },
    ];
    expect(dropZeroValues(nodes, []).nodes[0]!.props).toEqual({
      _meta: { deviations: [{ check: "C2", reason: "x", max: 0 }] },
    });
  });
});

// ---------------------------------------------------------------------------

function raw(n: number) {
  return { raw: n, _unbound: true as const };
}

/** A clipping frame with one oversized image in it — Figma's crop, in the DSL. */
function cutout(fit: string): FlatNode[] {
  return [
    { id: "frame", parent: null, idx: 0, type: "Overlay", src: "1:1", props: { clip: true } },
    {
      id: "image",
      parent: "frame",
      idx: 0,
      type: "Image",
      src: "1:2",
      props: {
        src: "",
        alt: "cutout",
        fit,
        place: { anchor: "top-start", offset: { block: raw(-40) } },
        size: { w: raw(400) },
      },
    },
  ];
}

function countZeroes(nodes: readonly FlatNode[]): number {
  let n = 0;
  const walk = (value: unknown, path: string): void => {
    if (path.startsWith("_meta")) return;
    if (value === "space.0" || (isRawValue(value) && value.raw === 0)) {
      n += 1;
      return;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  for (const node of nodes) walk(node.props, "");
  return n;
}

function isRawValue(v: unknown): v is { raw: number } {
  return typeof v === "object" && v !== null && (v as { _unbound?: unknown })._unbound === true;
}
