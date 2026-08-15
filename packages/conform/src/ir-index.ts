/**
 * Random access over a Frame IR document.
 *
 * The IR is a deep tree; every check here needs to go the other way — from a
 * `src` on a DSL node back to the Figma node, its ancestry, and its position
 * relative to some other node. Building the index once keeps every check O(n).
 */

import type { FrameIRDocument, FrameIRNode } from "@fanos/surface-canvas/ir";

export interface IrIndex {
  readonly doc: FrameIRDocument;
  readonly byId: ReadonlyMap<string, FrameIRNode>;
  readonly parentOf: ReadonlyMap<string, string>;
  /** Every node id, in document order. */
  readonly order: readonly string[];
}

export function indexIr(doc: FrameIRDocument): IrIndex {
  const byId = new Map<string, FrameIRNode>();
  const parentOf = new Map<string, string>();
  const order: string[] = [];
  const walk = (n: FrameIRNode, parent?: string) => {
    byId.set(n.id, n);
    order.push(n.id);
    if (parent !== undefined) parentOf.set(n.id, parent);
    for (const c of n.children ?? []) walk(c, n.id);
  };
  walk(doc.root);
  return { doc, byId, parentOf, order };
}

/** Ancestor ids, nearest first. */
export function ancestorsOf(ix: IrIndex, id: string): string[] {
  const out: string[] = [];
  let cur = ix.parentOf.get(id);
  while (cur !== undefined) {
    out.push(cur);
    cur = ix.parentOf.get(cur);
  }
  return out;
}

export function isDescendantOf(ix: IrIndex, id: string, ancestor: string): boolean {
  let cur = ix.parentOf.get(id);
  while (cur !== undefined) {
    if (cur === ancestor) return true;
    cur = ix.parentOf.get(cur);
  }
  return false;
}

/**
 * Position relative to `root`, by summing `relBbox` up the ancestry.
 *
 * `geometry.bbox` is absolute to the PAGE, which is useless for comparing a
 * component that was exported on its own — the same card sits at y=768 in one
 * export and y=0 in another. Accumulating `relBbox` gives a frame-local origin
 * that is stable across exports.
 *
 * Returns undefined when `id` is not inside `root`.
 */
export function offsetWithin(
  ix: IrIndex,
  id: string,
  root: string,
): { x: number; y: number } | undefined {
  let x = 0;
  let y = 0;
  let cur: string | undefined = id;
  while (cur !== undefined) {
    if (cur === root) return { x, y };
    const node = ix.byId.get(cur);
    if (!node) return undefined;
    x += node.geometry.relBbox.x;
    y += node.geometry.relBbox.y;
    cur = ix.parentOf.get(cur);
  }
  return undefined;
}

/**
 * Does this node put ink on the screen?
 *
 * A frame with no fill, stroke, text or image is pure scaffolding — the tree is
 * free to collapse it, and often should. Anything that paints is a different
 * matter: if it is missing from the tree, something visible is missing from the
 * render. That is the line C1 draws.
 *
 * Fully transparent nodes are excluded: they are in the file but not on screen.
 */
export function paints(n: FrameIRNode): boolean {
  if (n.opacity === 0) return false;
  if (n.text !== undefined && n.text.characters.trim() !== "") return true;
  if (n.image !== undefined) return true;
  if (n.fill !== null) return true;
  if (n.stroke !== null) return true;
  return n.effects.length > 0;
}
