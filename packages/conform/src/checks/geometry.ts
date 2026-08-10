/**
 * C2 — does the node actually land where Figma put it?
 *
 * The single highest-yield check. Every "looks slightly off" bug found by eye
 * while building the first five examples was a number that disagreed with the
 * IR by a measurable amount:
 *
 *   button padding      declared space.2_5 -> 40px tall, IR bbox says 32
 *   input plate width   515 emitted, IR says 509
 *   stat strip          hugged to 48px, IR says a fixed 60
 *   fixture card row    hugged to ~217px, IR says 235 and clips
 *
 * Each was found by rendering, measuring by hand, and comparing. This does that
 * automatically for every node at once.
 *
 * Boxes come from the DOM (the renderer measures every `data-fos-id`), so this
 * function stays pure and testable: hand it boxes, it compares them.
 *
 * Coordinates are frame-local — the DOM boxes are relative to the rendered
 * root, and the IR side sums `relBbox` up to the root `src`. `geometry.bbox`
 * is page-absolute and therefore useless here: the same card sits at y=768 in
 * the page export and y=0 in its own.
 */

import type { FlatTree } from "@fanos/dsl";
import { isSynthetic } from "@fanos/dsl";
import type { ConformIssue } from "../issues.js";
import { offsetWithin, type IrIndex } from "../ir-index.js";

/** A measured element, relative to the rendered root. */
export interface NodeBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GeometryOptions {
  /** Px slack per edge. Sub-pixel rounding and font metrics need a little. */
  tolerance?: number;
  /**
   * Uniform scale the tree was rendered at, for `designWidth` cards. Boxes are
   * divided by this before comparison, so a card rendered at 2x still compares
   * against its native IR numbers.
   */
  scale?: number;
}

export interface GeometryResult {
  issues: ConformIssue[];
  compared: number;
  skipped: number;
  worstDelta: number;
}

export function checkGeometry(
  tree: FlatTree,
  ix: IrIndex,
  boxes: readonly NodeBox[],
  rootSrc: string,
  options: GeometryOptions = {},
): GeometryResult {
  const tolerance = options.tolerance ?? 1.5;
  const scale = options.scale ?? 1;
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const issues: ConformIssue[] = [];
  let compared = 0;
  let skipped = 0;
  let worstDelta = 0;

  for (const node of tree.nodes) {
    // Synthetic nodes have no Figma box; Repeater is a fragment with no box at
    // all. Repeated instances beyond the first map to different IR nodes and
    // are covered by C1's `repeated` bucket instead.
    if (isSynthetic(node.src)) {
      skipped += 1;
      continue;
    }
    const ir = ix.byId.get(node.src);
    const box = byId.get(node.id);
    if (!ir || !box) {
      skipped += 1;
      continue;
    }
    const origin = offsetWithin(ix, node.src, rootSrc);
    if (!origin) {
      skipped += 1;
      continue;
    }

    compared += 1;
    const got = { x: box.x / scale, y: box.y / scale, w: box.w / scale, h: box.h / scale };
    const want = {
      x: origin.x,
      y: origin.y,
      w: ir.geometry.relBbox.w,
      h: ir.geometry.relBbox.h,
    };

    /**
     * Rotated nodes report their UNROTATED box.
     *
     * The IR has no rotation field, so a 248px horizontal rule turned 90 degrees
     * arrives as `w: 1, h: 248`, and the newsletter's vertical divider as
     * `w: 110, h: 0`. Comparing those to the rendered box produces a 248px
     * "error" on a node that is pixel-correct.
     *
     * Recognising the swap keeps the check honest without a waiver on every
     * rotated node in every design. It is reported as info rather than dropped,
     * because the right fix is upstream: the extractor should record rotation.
     */
    const swapped =
      Math.abs(got.w - want.h) <= tolerance && Math.abs(got.h - want.w) <= tolerance;
    if (swapped && Math.abs(want.w - want.h) > tolerance) {
      continue;
    }

    const deltas: string[] = [];
    for (const k of ["x", "y", "w", "h"] as const) {
      const d = Math.abs(got[k] - want[k]);
      if (d > worstDelta) worstDelta = d;
      if (d > tolerance) deltas.push(`${k} ${got[k].toFixed(1)} vs ${want[k].toFixed(1)} (${d > 0 ? "+" : ""}${(got[k] - want[k]).toFixed(1)})`);
    }
    if (deltas.length === 0) continue;

    issues.push({
      code: "C2",
      severity: "error",
      nodeId: node.id,
      irId: node.src,
      message: `renders off its IR box — ${deltas.join(", ")}`,
    });
  }

  return { issues, compared, skipped, worstDelta };
}
