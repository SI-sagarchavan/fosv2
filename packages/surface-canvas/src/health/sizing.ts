/**
 * Sizing contract — hug / fill / fixed.
 *
 * PURE. No Figma import.
 *
 * Geometry.relBbox is a photograph of one instance. layout.sizing is the
 * contract that survives `{headline}` and a Repeater. This report is what
 * Studio shows on the Layout tab so a designer can make that contract true
 * before compile emits `auto` / `full` / a pinned px.
 *
 * Pinned TEXT (autoResize NONE) is the one we can name a consequence for:
 * bound copy that is longer than "Hello" will clip. Truncate is a clamp,
 * not a bug. HEIGHT / WIDTH_AND_HEIGHT already hug.
 */
import type { AutoResize, FrameIRDocument, FrameIRNode } from "../ir/schema.js";
import { walkNodes } from "./slots.js";

export interface AxisTally {
  hug: number;
  fill: number;
  fixed: number;
  total: number;
}

export interface PinnedText {
  nodeId: string;
  name: string;
  autoResize: AutoResize;
  w: number;
  h: number;
  lines: number;
}

export interface SizingReport {
  axes: AxisTally;
  pinnedText: PinnedText[];
  huggingText: number;
  textTotal: number;
}

export function emptyAxes(): AxisTally {
  return { hug: 0, fill: 0, fixed: 0, total: 0 };
}

export function sizingReport(ir: FrameIRDocument): SizingReport {
  const axes = emptyAxes();
  const pinnedText: PinnedText[] = [];
  let huggingText = 0;
  let textTotal = 0;

  for (const node of walkNodes(ir.root)) {
    tallyAxis(axes, node.layout.sizing.w);
    tallyAxis(axes, node.layout.sizing.h);

    if (!node.text) continue;
    textTotal += 1;
    const resize = node.text.autoResize;
    if (resize === "NONE") {
      pinnedText.push({
        nodeId: node.id,
        name: node.name,
        autoResize: resize,
        w: node.geometry.relBbox.w,
        h: node.geometry.relBbox.h,
        lines: node.text.lines,
      });
    } else if (resize === "HEIGHT" || resize === "WIDTH_AND_HEIGHT") {
      huggingText += 1;
    }
  }

  return { axes, pinnedText, huggingText, textTotal };
}

function tallyAxis(axes: AxisTally, mode: "hug" | "fill" | "fixed"): void {
  axes.total += 1;
  axes[mode] += 1;
}

/** True when every text layer already hugs, so bindings can grow the box. */
export function sizingReady(report: SizingReport): boolean {
  return report.pinnedText.length === 0;
}
