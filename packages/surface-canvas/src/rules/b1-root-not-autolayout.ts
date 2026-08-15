/**
 * B1 — the page root is not a vertical auto-layout frame.
 *
 * PURE. No Figma import.
 *
 * There is no autofix. Setting `layoutMode = VERTICAL` on an existing frame
 * reflows every child and wrecks overlays, menus and screens that were drawn
 * with absolute positions. Wrapping is a designer's decision, not a bind.
 *
 * Overlay-like roots (most children absolutely placed) are not pages. Section
 * detection does not apply, so this rule stays quiet — a mobile menu is not a
 * page that failed to become a column.
 */
import type { FrameIRNode } from "../ir/schema.js";
import type { Rule } from "../health/types.js";
import { pageFinding } from "./shared.js";

export const rootNotAutolayout: Rule = {
  id: "root-not-autolayout",
  code: "B1",
  severity: "blocker",
  protects: "segmentation — reading section boundaries off the page structure",

  check(ir) {
    const root = ir.root;
    if (root.layout.mode === "vertical") return [];
    if (isOverlayLike(root)) return [];
    return [
      pageFinding({
        ruleId: "root-not-autolayout",
        severity: "blocker",
        nodeId: root.id,
        nodeName: root.name,
        propPath: "layout.mode",
        currentValue: root.layout.mode,
        message: "Not a column",
        hint: "Generation reads sections off a vertical auto-layout page. Wrap a page by hand — don't convert a screen or overlay.",
        detail: { layoutMode: root.layout.mode, rootNodeId: root.id, childCount: root.childCount },
        nodeIds: [root.id],
      }),
    ];
  },
};

/** Most children absolutely placed → a screen/overlay, not a page to segment. */
export function isOverlayLike(root: FrameIRNode): boolean {
  const kids = root.children;
  if (kids.length === 0) return false;
  const absolute = kids.filter((child) => child.layout.positioning === "absolute").length;
  return absolute * 2 >= kids.length;
}
