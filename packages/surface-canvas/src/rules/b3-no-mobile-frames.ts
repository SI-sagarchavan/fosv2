/**
 * B3 — no mobile artboard, so responsive values have nothing to be derived from.
 *
 * PURE. No Figma import.
 *
 * "Top level" is depth <= 1: the page root and its direct children. A 360px
 * frame nested six levels deep inside a desktop layout is a component preview,
 * not a mobile design of the page.
 */
import { walkNodes } from "../health/slots.js";
import type { Rule } from "../health/types.js";
import { pageFinding } from "./shared.js";

export const noMobileFrames: Rule = {
  id: "no-mobile-frames",
  code: "B3",
  severity: "blocker",
  protects: "responsive prop derivation — mobile values come from a mobile frame or from nowhere",

  check(ir, ctx) {
    const [min, max] = ctx.options.mobileWidthRange;
    const topLevel = walkNodes(ir.root).filter(
      (node) => node.depth <= 1 && (node.type === "FRAME" || node.type === "COMPONENT"),
    );
    const mobile = topLevel.filter((node) => {
      const w = node.geometry.bbox.w;
      return w >= min && w <= max;
    });
    if (mobile.length > 0) return [];

    const widths = [...new Set(topLevel.map((node) => Math.round(node.geometry.bbox.w)))]
      .sort((a, b) => a - b)
      .filter((w) => w > 0);

    return [
      pageFinding({
        ruleId: "no-mobile-frames",
        severity: "blocker",
        nodeId: "",
        nodeName: ir.pageName,
        propPath: "geometry.bbox.w",
        currentValue: widths.join(", ") || "none",
        message:
          "Desktop only. Responsive values will be guessed rather than derived from your design.",
        hint: `Add a top-level frame between ${min} and ${max}px wide and lay the page out at that width.`,
        detail: {
          widthsPresent: widths.join(", ") || "none",
          searchedRange: `${min}-${max}`,
          topLevelFrames: topLevel.length,
        },
      }),
    ];
  },
};
