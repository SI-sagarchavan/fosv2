/**
 * Bridge from pixels back to the tree.
 *
 * Render with `data-fos-id` on every element, read the DOM box for each, and
 * return which node ids intersect each mismatch region. This is what makes
 * automated repair possible at all.
 */

import type { FlatTree } from "@fanos/dsl";
import type { DiffRegion } from "./diff.js";

export interface NodeBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RegionNodes {
  region: DiffRegion;
  nodeIds: string[];
}

/**
 * Pure intersection: given pre-measured node boxes (from the DOM) and diff
 * regions, return node ids whose boxes intersect each region.
 */
export function mapRegionsToNodes(
  regions: DiffRegion[],
  nodeBoxes: NodeBox[],
  _tree?: FlatTree,
): RegionNodes[] {
  return regions.map((region) => {
    const nodeIds = nodeBoxes
      .filter((box) => intersects(region, box))
      .map((b) => b.id);
    // Prefer deeper (smaller) nodes first so the repair loop sees the most
    // specific culprit before its ancestors.
    nodeIds.sort((a, b) => {
      const ba = nodeBoxes.find((n) => n.id === a)!;
      const bb = nodeBoxes.find((n) => n.id === b)!;
      return ba.w * ba.h - bb.w * bb.h;
    });
    return { region, nodeIds };
  });
}

function intersects(a: DiffRegion, b: NodeBox): boolean {
  return !(
    a.x + a.w <= b.x ||
    b.x + b.w <= a.x ||
    a.y + a.h <= b.y ||
    b.y + b.h <= a.y
  );
}

/**
 * Playwright helper script body: collect data-fos-id boxes relative to root.
 * Returned as a string so the harness can page.evaluate it without bundling.
 */
export const COLLECT_NODE_BOXES_SCRIPT = `(() => {
  const root = document.querySelector("[data-fos-root]");
  if (!root) return [];
  const rootRect = root.getBoundingClientRect();
  return Array.from(document.querySelectorAll("[data-fos-id]")).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      id: el.getAttribute("data-fos-id"),
      x: Math.round(r.left - rootRect.left),
      y: Math.round(r.top - rootRect.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });
})()`;
