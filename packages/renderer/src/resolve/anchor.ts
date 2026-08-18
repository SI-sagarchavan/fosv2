/**
 * Overlay anchor → CSS logical properties.
 *
 * Pure. Highest-risk piece of the renderer — every subtle wrongness in badge
 * placement and cutout overflow hides here, and it is cheap to pin down with an
 * exhaustive table test.
 *
 * Logical properties throughout (inset-block-*, inset-inline-*) — never
 * top/left/right/bottom — because ICC needs RTL and retrofitting is miserable.
 *
 * Offsets are edge-relative: they become the inset on the anchored edge.
 * Negative values push outward (badges hang with `inline: "-space.6"`).
 * On a centered axis the offset shifts from 50%.
 */

import type { Anchor, OffsetValue } from "@fanos/dsl";
import { resolveValue } from "./value.js";

export type CssProperties = Record<string, string>;

export interface PlaceInput {
  anchor?: Anchor;
  offset?: {
    block?: OffsetValue | string | number;
    inline?: OffsetValue | string | number;
  };
  z?: number;
}

type AxisEdge = "start" | "center" | "end" | "both";

const ANCHOR_AXES: Record<Anchor, { block: AxisEdge; inline: AxisEdge }> = {
  fill: { block: "both", inline: "both" },
  "top-start": { block: "start", inline: "start" },
  "top-center": { block: "start", inline: "center" },
  "top-end": { block: "start", inline: "end" },
  "top-fill": { block: "start", inline: "both" },
  "mid-start": { block: "center", inline: "start" },
  center: { block: "center", inline: "center" },
  "mid-end": { block: "center", inline: "end" },
  "mid-fill": { block: "center", inline: "both" },
  "bottom-start": { block: "end", inline: "start" },
  "bottom-center": { block: "end", inline: "center" },
  "bottom-end": { block: "end", inline: "end" },
  "bottom-fill": { block: "end", inline: "both" },
};

/**
 * Resolve an Overlay child's place to absolute-position CSS.
 */
export function resolveAnchor(place: PlaceInput | undefined | null): CssProperties {
  if (!place?.anchor) return {};

  /**
   * An anchor this renderer does not know falls back to `top-start`.
   *
   * Trees are stored artifacts, replayed by whatever renderer is running later,
   * so the two versions skew as a matter of course — a tree compiled with
   * `top-fill` was handed to a dev server still holding the table from before
   * that anchor existed, and the undefined lookup took down the whole page with
   * "Cannot read properties of undefined". One node placed conservatively is a
   * far better failure than no page: `top-start` is where the IR measured the
   * node from, so it lands in the right place and merely stops stretching.
   *
   * Silent by design — this file is pure, and an anchor outside the vocabulary
   * is already an S12 error from the DSL validator, which is the layer whose
   * job it is to say so.
   */
  const axes = ANCHOR_AXES[place.anchor] ?? ANCHOR_AXES["top-start"];
  const blockOff =
    place.offset?.block !== undefined ? resolveValue(place.offset.block).css : undefined;
  const inlineOff =
    place.offset?.inline !== undefined ? resolveValue(place.offset.inline).css : undefined;

  const style: CssProperties = { position: "absolute" };
  if (place.z !== undefined) style.zIndex = String(place.z);

  applyAxis(style, "block", axes.block, blockOff);
  applyAxis(style, "inline", axes.inline, inlineOff);

  // Centering transforms — logical, independent of writing mode for the shift
  // magnitude (50% of self size). Combined when both axes center.
  const tx = axes.inline === "center" ? "-50%" : "0";
  const ty = axes.block === "center" ? "-50%" : "0";
  if (tx !== "0" || ty !== "0") {
    style.transform =
      tx !== "0" && ty !== "0" ? `translate(${tx}, ${ty})` : tx !== "0" ? `translateX(${tx})` : `translateY(${ty})`;
  }

  return style;
}

function applyAxis(
  style: CssProperties,
  axis: "block" | "inline",
  edge: AxisEdge,
  offset: string | undefined,
): void {
  const start = axis === "block" ? "insetBlockStart" : "insetInlineStart";
  const end = axis === "block" ? "insetBlockEnd" : "insetInlineEnd";

  switch (edge) {
    case "start":
      style[start] = offset ?? "0";
      break;
    case "end":
      // Offset is from the end edge. Negative token already means outward.
      style[end] = offset ?? "0";
      break;
    case "center":
      style[start] = offset ? `calc(50% + ${offset})` : "50%";
      break;
    case "both":
      style[start] = offset ?? "0";
      style[end] = offset ?? "0";
      break;
  }
}
