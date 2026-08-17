/**
 * Where a marked bitmap actually sits inside the element it paints.
 *
 * This is the fact that decides whether a background is a SURFACE or a NODE,
 * and getting it wrong is the difference between a 200x80 plate at (40,120) and
 * a full-bleed wash over the whole frame. Both readings render; only one is the
 * design.
 *
 * Lives in `ir/` rather than next to the compiler because two very different
 * callers need the same answer from the same numbers: the compiler, to choose
 * what to emit, and the plugin panel, to warn the designer at the moment they
 * mark something that its box does not cover its target.
 *
 * PURE. Absolute boxes only — `geometry.bbox` — because a binding's source and
 * target need not be parent and child. A designer can bind a plate to the
 * section two levels up, and `relBbox` is measured against the immediate parent,
 * so subtracting the two would be arithmetic on unrelated origins.
 */
import type { FrameIRNode, Rect } from "./schema.js";

/**
 * How far the source box may fall short of the target and still count as
 * covering it, in px.
 *
 * Not zero. A plate drawn to the edge of its frame comes back through an
 * instance transform a fraction of a pixel small — the same drift that made an
 * exact bound misclassify every hairline in the fixtures card as a box — and a
 * strict test would push those onto the positioned path, where they would
 * acquire a `place` and a pinned size for no reason.
 */
export const COVER_TOLERANCE = 1;

export interface AssetPlacement {
  /**
   * True when the bitmap fills its target. Such a mark is the target's
   * surface, and the source node itself is not content — it is how Figma spells
   * "this frame has a picture behind it".
   */
  covers: boolean;
  /** Source box relative to the target's top-left. */
  offset: { x: number; y: number };
  size: { w: number; h: number };
  /** The target's own box, so a caller can describe the mismatch. */
  target: { w: number; h: number };
}

/**
 * Where `source` sits inside `target`.
 *
 * A source LARGER than its target still covers it — a bleeding plate is the
 * common case, and clipping is the target's business, not the mark's.
 */
export function assetPlacement(source: FrameIRNode, target: FrameIRNode): AssetPlacement {
  return compositePlacement([source], target);
}

/**
 * Where a whole composite lands inside its target.
 *
 * The union, not each part. A header made of a gradient plate, a facet shape
 * and a white cutout has no single layer that covers the section — but the
 * flattened bitmap does, and that bitmap is what gets painted. Judging any one
 * member on its own would call the composite "placed" and emit it as a small
 * positioned node in the corner of the thing it is supposed to fill.
 *
 * @param sources at least one; an empty list has no placement to report
 */
export function compositePlacement(
  sources: readonly FrameIRNode[],
  target: FrameIRNode,
): AssetPlacement {
  const t = target.geometry.bbox;
  const s = unionBox(sources.map((node) => node.geometry.bbox)) ?? { x: t.x, y: t.y, w: 0, h: 0 };

  return {
    covers: sources.length > 0 && covers(s, t),
    offset: { x: round(s.x - t.x), y: round(s.y - t.y) },
    size: { w: round(s.w), h: round(s.h) },
    target: { w: round(t.w), h: round(t.h) },
  };
}

/** The smallest box containing all of them, or null for an empty list. */
export function unionBox(boxes: readonly Rect[]): Rect | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** A frame a mark could be bound to, with the placement it would produce. */
export interface TargetOption {
  id: string;
  name: string;
  width: number;
  height: number;
  /** How far up from the marked node — 1 is its immediate parent. */
  depth: number;
  /** Would the bitmap cover this frame, and so paint as its surface? */
  covers: boolean;
}

/**
 * The frames a marked node could sensibly paint: its ancestors.
 *
 * This exists to replace picking a target by canvas selection, which was the
 * worst possible mechanism for it. The offer was built from whatever happened
 * to be selected in Figma, so it appeared and vanished as the designer clicked
 * around — and clicking the marked image itself, the obvious thing to do while
 * deciding where it should go, destroyed the offer entirely.
 *
 * An ancestor list is stable, always present, and is very nearly the exact set
 * of correct answers: a background paints the thing it sits inside. Each option
 * carries whether the mark would cover it, because that decides whether the
 * result is a surface or a positioned node — a real difference the designer
 * should see while choosing, not discover in a preview.
 *
 * Ordered nearest-first: the immediate parent is the common answer.
 */
export function targetOptions(root: FrameIRNode, sourceId: string): TargetOption[] {
  const chain = ancestorChain(root, sourceId);
  if (chain === null) return [];

  const { source, ancestors } = chain;
  return ancestors.map((node, index) => ({
    id: node.id,
    name: node.name,
    width: Math.round(node.geometry.bbox.w),
    height: Math.round(node.geometry.bbox.h),
    depth: index + 1,
    covers: assetPlacement(source, node).covers,
  }));
}

/** The marked node and its ancestors, nearest first. Null if not in this tree. */
function ancestorChain(
  root: FrameIRNode,
  sourceId: string,
): { source: FrameIRNode; ancestors: FrameIRNode[] } | null {
  const path: FrameIRNode[] = [];

  function walk(node: FrameIRNode): boolean {
    path.push(node);
    if (node.id === sourceId) return true;
    for (const child of node.children ?? []) {
      if (walk(child)) return true;
    }
    path.pop();
    return false;
  }

  if (!walk(root)) return null;
  const source = path[path.length - 1]!;
  // Everything above it, nearest first.
  return { source, ancestors: path.slice(0, -1).reverse() };
}

/** Does `s` contain `t` on both axes, within tolerance? */
function covers(s: Rect, t: Rect): boolean {
  const e = COVER_TOLERANCE;
  return (
    s.x <= t.x + e && s.y <= t.y + e && s.x + s.w >= t.x + t.w - e && s.y + s.h >= t.y + t.h - e
  );
}

/** Four decimals, matching the compiler. More just makes trees noisy to diff. */
function round(n: number): number {
  return Number(n.toFixed(4));
}
