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
  /** Nodes whose content comes from outside the frame. See `isExternallyProvided`. */
  exempt: number;
  worstDelta: number;
  /**
   * Sum of every failing node's worst axis delta, in px.
   *
   * The number to watch, because the error COUNT barely moves. Fixing the
   * rotated-position bug removed 8,365px of error and changed the count by
   * zero; a 262px container collapse and a 2px rounding difference each count
   * as exactly one error. Magnitude is what tracks progress.
   */
  totalDelta: number;
}

/**
 * Is this node's content the frame's to dictate?
 *
 * An `Icon` names a glyph in the icon library. What Figma holds is the
 * designer's drawing of that glyph — a different artefact, drawn at whatever
 * aspect suited the canvas, often several vector paths deep. Holding the
 * library's rendering to that drawing's bounding box is comparing two things
 * that were never meant to be the same object: it fails on every icon in every
 * design, and the only way to "pass" is to stop using the library.
 *
 * Team badges are the same argument one step further out — those arrive from
 * the API per fixture, so the frame's placeholder says nothing about the real
 * one.
 *
 * The SLOT is still checked. The parent that positions the icon is compared
 * like any other node, so an icon in the wrong place, or a row that is the
 * wrong height, still fails. Only the glyph's own box is out of scope.
 */
function isExternallyProvided(type: string): boolean {
  return type === "Icon";
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
  let exempt = 0;
  let worstDelta = 0;
  let totalDelta = 0;

  for (const node of tree.nodes) {
    // Synthetic nodes have no Figma box; Repeater is a fragment with no box at
    // all. Repeated instances beyond the first map to different IR nodes and
    // are covered by C1's `repeated` bucket instead.
    if (isSynthetic(node.src)) {
      skipped += 1;
      continue;
    }
    // Counted, not hidden. "419 icons exempt" is a fact a reader can argue
    // with; silently comparing nothing is what this gate exists to prevent.
    if (isExternallyProvided(node.type)) {
      exempt += 1;
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

    /**
     * `relBbox` is the node's box BEFORE rotation, so a quarter-turned node
     * expects its axes transposed. `geometry.rotation` now records this, which
     * turns what used to be a guess (below) into a correction: the expectation
     * is fixed up and the node is still compared, rather than skipped.
     */
    const turned = isQuarterTurn(ir.geometry.rotation);
    const want = {
      x: origin.x,
      y: origin.y,
      w: turned ? ir.geometry.relBbox.h : ir.geometry.relBbox.w,
      h: turned ? ir.geometry.relBbox.w : ir.geometry.relBbox.h,
    };

    /**
     * Legacy fallback for IR captured before `geometry.rotation` existed, where
     * rotation defaults to 0 and the transposition above cannot be detected.
     * Recognising the swap by shape keeps those documents from reporting a
     * 248px "error" on a node that is pixel-correct.
     *
     * Documents that carry rotation never reach this: they were corrected
     * above, and are compared rather than skipped.
     */
    if (!turned) {
      const swapped =
        Math.abs(got.w - want.h) <= tolerance && Math.abs(got.h - want.w) <= tolerance;
      if (swapped && Math.abs(want.w - want.h) > tolerance) {
        continue;
      }
    }

    const deltas: string[] = [];
    let nodeWorst = 0;
    for (const k of ["x", "y", "w", "h"] as const) {
      const d = Math.abs(got[k] - want[k]);
      if (d > worstDelta) worstDelta = d;
      if (d > nodeWorst) nodeWorst = d;
      if (d > tolerance) deltas.push(`${k} ${got[k].toFixed(1)} vs ${want[k].toFixed(1)} (${d > 0 ? "+" : ""}${(got[k] - want[k]).toFixed(1)})`);
    }
    if (deltas.length === 0) continue;

    // One node contributes once, by its worst axis — otherwise a node that is
    // off on all four axes would count four times and dominate the total.
    totalDelta += nodeWorst;

    issues.push({
      code: "C2",
      severity: "error",
      nodeId: node.id,
      irId: node.src,
      message: `renders off its IR box — ${deltas.join(", ")}`,
      delta: nodeWorst,
    });
  }

  return { issues, compared, skipped, exempt, worstDelta, totalDelta: Math.round(totalDelta) };
}

/**
 * Within half a degree of ±90 — the only rotation with a rectangular layout
 * box. Instance transforms drift, so this is a tolerance, not equality.
 */
function isQuarterTurn(rotation: number | undefined): boolean {
  if (typeof rotation !== "number" || !Number.isFinite(rotation)) return false;
  return Math.abs(Math.abs(((rotation % 180) + 180) % 180) - 90) < 0.5;
}
