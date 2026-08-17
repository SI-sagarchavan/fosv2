/**
 * Vector artwork: the shapes nothing downstream can reproduce.
 *
 * The IR carries no path data — not a single coordinate. So a club crest, a
 * header swoosh and a brand arc are all, to every consumer, a name and a box.
 * The compiler does what it can with that: an icon-sized cluster becomes one
 * `Icon` for a glyph registry to resolve, and anything larger becomes a `Box`
 * with the right paint and the wrong outline.
 *
 * Neither is the artwork. The only way to actually ship it is as a bitmap, and
 * the only person who can decide that is the designer — which is what the
 * Assets tab is for. This module is what lets the panel offer it: it finds the
 * clusters that will not survive compilation, so marking one is a decision
 * about a specific thing on screen rather than a guess.
 *
 * Lives in `ir/` because both ends need the same answer from the same rule. The
 * compiler decides what to emit with it; the panel decides what to offer.
 *
 * PURE. No Figma.
 */
import type { FrameIRNode } from "./schema.js";

/**
 * The largest box that can still be one glyph, in px.
 *
 * The only fact in the IR that separates a chevron from a background swoosh is
 * how much room it takes, so this constant is the whole discriminator between
 * an icon and decoration.
 */
export const MAX_ICON_PX = 64;

/**
 * Is this node, and everything under it, nothing but vector paths?
 *
 * Groups and frames that exist only to hold paths — clip groups, boolean ops,
 * the wrapper an SVG paste leaves behind — count as part of the artwork. A node
 * carrying text or a bitmap does not, however small: that is content in a box,
 * and collapsing it would delete the content.
 */
export function isVectorOnly(n: FrameIRNode): boolean {
  if (n.text !== undefined || n.image !== undefined) return false;
  const kids = n.children ?? [];
  if (kids.length === 0) return n.type === "VECTOR";
  // An instance or component with children is a reusable piece of UI, not a
  // glyph — even when everything inside it happens to be a path.
  if (n.type === "TEXT") return false;
  return kids.every(isVectorOnly);
}

/** Vector leaves in this subtree. A logo is dozens; a chevron is one. */
export function countPaths(n: FrameIRNode): number {
  const kids = n.children ?? [];
  if (kids.length === 0) return n.type === "VECTOR" ? 1 : 0;
  return kids.reduce((total, child) => total + countPaths(child), 0);
}

/**
 * Does this subtree contain any text, at any depth?
 *
 * The test that decides what a background photo is allowed to swallow. When an
 * uploaded image covers an element, everything decorative inside it is already
 * in the picture and must not be drawn again on top — but text is never safe to
 * absorb. Baking a headline into a bitmap freezes copy the CMS is supposed to
 * change, and no amount of visual fidelity is worth that.
 */
export function hasText(n: FrameIRNode): boolean {
  if (n.text !== undefined) return true;
  return (n.children ?? []).some(hasText);
}
