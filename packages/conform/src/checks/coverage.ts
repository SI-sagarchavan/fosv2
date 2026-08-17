/**
 * C1 — did anything visible get left behind?
 *
 * This is the check that would have caught the most damage. Three times while
 * building the first five examples an entire branch went missing — the fixture
 * card's date strip and grey shell, the frame that centres its rows, all four
 * video captions — and every one of those trees validated clean and rendered
 * without complaint. They just quietly showed less than the design.
 *
 * Not every IR node needs a node of its own. Three ways to be accounted for:
 *
 *   direct    its id is a `src` in the tree
 *   absorbed  an ancestor is a `src` whose tree node is a LEAF (the six 2x2
 *             ellipses Figma uses to draw a ":" are absorbed by the one Text
 *             that draws it; a vector path by its Icon), OR it is a paint-only
 *             node exactly filling a claimed ancestor's box — which is what a
 *             `surface` is: Figma draws the plate behind the newsletter input
 *             as a 509x52 rectangle, we draw it as a token
 *   repeated  it hangs under a container whose tree node holds a Repeater, so
 *             one subtree in the tree stands for N in the design
 *
 * Anything that paints and is none of those is missing, and is an error.
 *
 * The two narrow rules replaced a looser one that matched on
 * `canonicalSignature` alone. That version quietly "covered" 13 nodes on the
 * player card, which has no Repeater at all — signatures collide across
 * unrelated art, and a check that excuses things by coincidence is worse than
 * no check. Genuine substitutions declare themselves via `_meta.deviations`.
 */

import type { FlatTree } from "@fanos/dsl";
import { isSynthetic, nodeSpec } from "@fanos/dsl";
import type { ConformIssue } from "../issues.js";
import { ancestorsOf, isDescendantOf, paints, type IrIndex } from "../ir-index.js";

export interface CoverageResult {
  issues: ConformIssue[];
  counts: { paints: number; direct: number; absorbed: number; repeated: number; missing: number };
}

/** Resolve the IR node a `src` points at, seeing through `synthetic:`. */
function baseSrc(src: string): string {
  return isSynthetic(src) ? src.slice("synthetic:".length).replace(/:\d+$/, "") : src;
}

export function checkCoverage(tree: FlatTree, ix: IrIndex, rootSrc: string): CoverageResult {
  const issues: ConformIssue[] = [];

  /** src -> the tree node that claims it (first wins; C5 reports duplicates). */
  const claimed = new Map<string, string>();
  for (const n of tree.nodes) {
    const b = baseSrc(n.src);
    if (!claimed.has(b)) claimed.set(b, n.id);
  }

  /** srcs whose tree node is a leaf, so they subsume their IR descendants. */
  const leafSrcs = new Set<string>();
  for (const n of tree.nodes) {
    if (nodeSpec(n.type)?.kind === "leaf") leafSrcs.add(baseSrc(n.src));
  }

  /**
   * srcs of containers that hold a Repeater. Everything under them in the IR is
   * emitted N times from one subtree, so only the instance the tree points at
   * is ever claimed — the rest are covered, not missing.
   */
  const repeatContainers = new Set<string>();
  for (const n of tree.nodes) {
    if (n.type !== "Repeater" || n.parent === null) continue;
    const parent = tree.nodes.find((p) => p.id === n.parent);
    if (parent) repeatContainers.add(baseSrc(parent.src));
  }

  /** Does a claimed ancestor's `surface` account for this node's paint? */
  const surfaceSrcs = new Set<string>();
  for (const n of tree.nodes) {
    if ((n.props as { surface?: unknown }).surface !== undefined) surfaceSrcs.add(baseSrc(n.src));
  }
  const sameBox = (a: { w: number; h: number }, b: { w: number; h: number }) =>
    Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1;

  const counts = { paints: 0, direct: 0, absorbed: 0, repeated: 0, missing: 0 };

  for (const id of ix.order) {
    if (id !== rootSrc && !isDescendantOf(ix, id, rootSrc)) continue;
    const node = ix.byId.get(id)!;
    if (!paints(node)) continue;
    counts.paints += 1;

    if (claimed.has(id)) {
      counts.direct += 1;
      continue;
    }

    const ancestors = ancestorsOf(ix, id);

    // A leaf swallows its whole subtree: the ellipses under a ":" Text, the
    // path under an Icon.
    if (ancestors.some((a) => leafSrcs.has(a))) {
      counts.absorbed += 1;
      continue;
    }

    // A surface swallows the paint-only node that fills exactly the same box —
    // Figma's fill rectangle, drawn by us as a token.
    const bySurface =
      node.text === undefined &&
      node.image === undefined &&
      ancestors.some((a) => {
        if (!surfaceSrcs.has(a)) return false;
        const anc = ix.byId.get(a);
        return anc !== undefined && sameBox(node.geometry.relBbox, anc.geometry.relBbox);
      });
    if (bySurface) {
      counts.absorbed += 1;
      continue;
    }

    // Under a Repeater's container, and not the instance the tree points at.
    if (ancestors.some((a) => repeatContainers.has(a))) {
      counts.repeated += 1;
      continue;
    }

    /**
     * Vector interior. A glyph is one slot, not its paths.
     *
     * A team badge arrives as nine overlapping VECTORs; the tree carries one
     * node for it and fills that node from the icon library or the API. Asking
     * the tree to account for each path individually is asking it to redraw the
     * logo, which is the opposite of what a slot is for — and it fails loudest
     * on exactly the artwork the design system already owns.
     *
     * Narrow on purpose: the node itself must be a VECTOR, and some ancestor
     * must already be represented. An unclaimed subtree still reports missing,
     * so a whole logo dropped on the floor is still an error.
     */
    if (node.type === "VECTOR" && ancestors.some((a) => claimed.has(a))) {
      counts.absorbed += 1;
      continue;
    }

    counts.missing += 1;
    const owner = ancestors.find((a) => claimed.has(a));
    const where = owner ? `${claimed.get(owner)} (${owner})` : undefined;
    issues.push({
      code: "C1",
      severity: "error",
      irId: id,
      // Attributed to the nearest represented ancestor, which is both where a
      // human would go to fix it and the only node that can carry a
      // `_meta.deviations` waiver for it. A missing node has no tree node of
      // its own — that is the entire complaint — so without this, an omission
      // that IS deliberate (the card background replaced by one exported PNG
      // instead of 38 vectors) could never be declared.
      nodeId: owner ? claimed.get(owner) : undefined,
      message:
        `"${node.name}" [${node.type}] ${Math.round(node.geometry.relBbox.w)}x` +
        `${Math.round(node.geometry.relBbox.h)} paints but nothing in the tree represents it` +
        (where ? ` — nearest represented ancestor is ${where}` : ""),
    });
  }

  return { issues, counts };
}
