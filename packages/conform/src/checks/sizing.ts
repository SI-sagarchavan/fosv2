/**
 * C3 — a hardcoded pixel where Figma said "hug" or "fill".
 *
 * `layout.sizing` is the intrinsic-sizing contract and it maps straight onto
 * CSS: hug is `width: auto`, fill is `flex: 1 1 0`. Writing the bbox instead
 * throws that away and pins the node to the one width the frame was exported
 * at, which is exactly how a page stops being responsive.
 *
 * This is not theoretical — an audit of the first five examples found 9 of 44
 * raw sizes contradicting the IR this way. All nine were avoidable.
 *
 * The reverse is deliberately NOT an error: `auto` where Figma says fixed is
 * often the right call for a section column, which should become
 * `w: full` + `maxW`, not a pinned 1173px.
 */

import type { FlatTree } from "@fanos/dsl";
import { isSynthetic } from "@fanos/dsl";
import type { ConformIssue } from "../issues.js";
import type { IrIndex } from "../ir-index.js";

const AXIS = { w: "w", h: "h" } as const;

function isRaw(v: unknown): v is { raw: number } {
  return typeof v === "object" && v !== null && (v as { _unbound?: boolean })._unbound === true;
}

export function checkSizing(tree: FlatTree, ix: IrIndex): ConformIssue[] {
  const out: ConformIssue[] = [];

  for (const node of tree.nodes) {
    // A synthetic node has no Figma sizing of its own to contradict.
    if (isSynthetic(node.src)) continue;
    const ir = ix.byId.get(node.src);
    if (!ir) continue;

    const size = (node.props as { size?: Record<string, unknown> }).size;
    if (!size) continue;

    for (const axis of [AXIS.w, AXIS.h] as const) {
      const value = size[axis];
      if (!isRaw(value)) continue;
      const mode = ir.layout.sizing[axis];
      if (mode === "fixed") continue;

      const suggestion = mode === "hug" ? '"auto"' : '"full"';
      out.push({
        code: "C3",
        severity: "error",
        nodeId: node.id,
        irId: node.src,
        message:
          `size.${axis} is a hardcoded ${value.raw}px but the IR says sizing.${axis}=${mode} — ` +
          `use ${suggestion} so it survives a different viewport`,
      });
    }
  }

  return out;
}
