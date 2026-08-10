/**
 * Cut a subtree out of a Frame IR document as a document in its own right.
 *
 * Two reasons this exists.
 *
 * A page export is one file containing every section. Checking one component
 * against it means carrying 5,000 nodes to look at 20, and every check has to
 * keep re-deriving "is this inside my frame".
 *
 * The other reason is sharper: exports drift. The newsletter band exported on
 * its own on Aug 9 has 19 nodes; the same `1:5093` inside the page export from
 * Aug 7 has 35, because a stray yellow "Menu_17" component was still in the
 * file then. Conformance run against the wrong export reports twelve missing
 * nodes that were correctly never built. Slicing the exact frame a tree was
 * generated from, and committing it next to the tree, makes the comparison
 * reproducible instead of dependent on which file someone happens to pass.
 */

import type { FrameIRDocument, FrameIRNode } from "@fanos/figma-ir-extractor/ir";

/**
 * @param doc   the source document
 * @param id    the node to become the new root
 * @returns a document rooted at `id`, or undefined if it is not in `doc`
 */
export function sliceIr(doc: FrameIRDocument, id: string): FrameIRDocument | undefined {
  const found = find(doc.root, id);
  if (!found) return undefined;
  return {
    ...doc,
    rootNodeId: found.id,
    // `bbox` is page-absolute and stays truthful; `relBbox` is what every check
    // reads, and for a root it is relative to nothing, so it is zeroed. Leaving
    // the old parent offset in would shift the whole frame.
    root: { ...found, geometry: { ...found.geometry, relBbox: { ...found.geometry.relBbox, x: 0, y: 0 } } },
  };
}

function find(node: FrameIRNode, id: string): FrameIRNode | undefined {
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return undefined;
}
