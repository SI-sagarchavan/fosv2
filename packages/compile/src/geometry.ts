/**
 * Geometry facts the rest of the compiler reads.
 *
 * Split out so `classify` and `props` can both use it without importing each
 * other: classification needs the rotated box to recognise a rule, and prop
 * emission needs it to size one.
 */

import type { FrameIRNode } from "@fanos/surface-canvas/ir";

/**
 * The node's box as it occupies space on screen.
 *
 * `relBbox` carries Figma's `width`/`height`, which are the node's own
 * dimensions BEFORE rotation. A quarter-turned node therefore reports them
 * transposed relative to the room it actually takes up, and reading it
 * literally is how a 552x1 rule laid flat compiles to a 552x552 square.
 *
 * Only quarter turns transpose cleanly. An arbitrary angle has no rectangular
 * layout box at all — CSS would need a transform, which this compiler does not
 * emit — so those are left alone rather than approximated into a wrong number.
 */
export function layoutBox(n: FrameIRNode): { x: number; y: number; w: number; h: number } {
  const box = n.geometry.relBbox;
  return isQuarterTurn(n.geometry.rotation) ? { ...box, w: box.h, h: box.w } : box;
}

/** Within half a degree of ±90. Instance transforms drift a little. */
export function isQuarterTurn(rotation: number | undefined): boolean {
  if (typeof rotation !== "number" || !Number.isFinite(rotation)) return false;
  return Math.abs(Math.abs(((rotation % 180) + 180) % 180) - 90) < 0.5;
}
