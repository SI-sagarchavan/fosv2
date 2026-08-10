/**
 * What kind of DSL node is this IR node, and should it exist at all?
 *
 * Two decisions, and the second matters as much as the first. A faithful tree
 * is not a 1:1 copy of the IR — Figma draws a filled frame as a frame plus a
 * rectangle, a ":" as six 2x2 ellipses, an icon as a group of paths. Emitting
 * all of those produces a tree nobody can read that renders identically to one
 * half the size.
 *
 * Every rule here is decidable from the IR alone. Where it cannot be decided,
 * the compiler emits the safe thing and records a note, rather than guessing.
 */

import type { FrameIRNode } from "@fanos/figma-ir-extractor/ir";

export type DslType = "Box" | "Stack" | "Overlay" | "Text" | "Image" | "Icon" | "Divider";

/** A line: one dimension collapsed. Figma stores rules as zero-height vectors. */
export function isRule(n: FrameIRNode): boolean {
  const { w, h } = n.geometry.relBbox;
  return n.type === "VECTOR" && (w <= 1 || h <= 1) && Math.max(w, h) > 2;
}

/** Children that participate in flow, as opposed to being absolutely placed. */
export function flowChildren(n: FrameIRNode): FrameIRNode[] {
  return (n.children ?? []).filter((c) => c.layout.positioning !== "absolute");
}

export function hasAbsoluteChild(n: FrameIRNode): boolean {
  return (n.children ?? []).some((c) => c.layout.positioning === "absolute");
}

export function classify(n: FrameIRNode): DslType {
  if (n.text !== undefined) return "Text";
  if (n.image !== undefined) return "Image";
  if (isRule(n)) return "Divider";
  if (n.type === "VECTOR") return "Icon";

  const kids = n.children ?? [];
  if (kids.length === 0) return "Box";
  // Auto-layout is the common case and the only one with a flow algorithm.
  if (n.layout.mode !== "none") return hasAbsoluteChild(n) ? "Overlay" : "Stack";
  // No auto-layout but children: every child is positioned by its own box,
  // which is exactly what Overlay means.
  return "Overlay";
}

/**
 * Is this node just how Figma spells its parent's fill?
 *
 * A frame with a background is stored as the frame plus a child rectangle at
 * exactly the frame's size. That rectangle is not a node in any meaningful
 * sense — it is the parent's `surface` — and emitting it doubles the tree while
 * changing nothing on screen.
 *
 * Deliberately strict: same box within a pixel, no text, no image, no children
 * of its own. Anything looser starts swallowing real content.
 */
export function isFillPlate(n: FrameIRNode, parent: FrameIRNode): boolean {
  if (n.text !== undefined || n.image !== undefined) return false;
  if ((n.children ?? []).length > 0) return false;
  if (n.fill === null && n.stroke === null) return false;
  if (isRule(n)) return false;
  const a = n.geometry.relBbox;
  const b = parent.geometry.relBbox;
  return Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1 && Math.abs(a.x) < 1 && Math.abs(a.y) < 1;
}

/**
 * A group of vector paths that together draw one glyph.
 *
 * Figma has no notion of "icon", so an icon arrives as a frame containing one
 * or more `Vector` children. Reproducing the paths is impossible from the IR
 * (it carries no path data at all), so the whole group collapses to a single
 * `Icon` and the renderer draws a registered glyph.
 *
 * Requires a small box, so a full-bleed decorative vector stack — the player
 * card's background — is NOT mistaken for an icon.
 */
export function isIconGroup(n: FrameIRNode): boolean {
  const kids = n.children ?? [];
  if (kids.length === 0 || kids.length > 6) return false;
  if (n.text !== undefined || n.image !== undefined) return false;
  const { w, h } = n.geometry.relBbox;
  if (w > 64 || h > 64) return false;
  return kids.every((c) => c.type === "VECTOR" && (c.children ?? []).length === 0);
}
