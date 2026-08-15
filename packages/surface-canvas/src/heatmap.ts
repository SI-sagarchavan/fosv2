/**
 * The heatmap overlay. FIGMA-AWARE.
 *
 * One locked top-level frame named `__fos_heatmap__`, one semi-transparent rect
 * per node, removed entirely on toggle off and on plugin close.
 *
 *   green  every slot on the node is bound
 *   red    the node has loose values
 *   amber  the node is inside a blocker — a group, or a non-auto-layout root
 *
 * A heatmap left behind in a client file is the fastest way to lose trust in the
 * tool, so cleanup is defensive to the point of paranoia:
 *
 *   - `figma.on("close")` removes it
 *   - `clearStaleOverlays()` runs at startup and removes any frame with this
 *     name, including one orphaned by a previous session that crashed
 *   - the frame is locked, `expanded: false`, and excluded from export
 *
 * It draws at most MAX_RECTS rects. A 1,596-node page is fine; a pathological
 * one would otherwise freeze the canvas, and a partial heatmap that says so
 * beats a hung editor.
 */
import { enumerateSlots, walkNodes } from "./health/slots.js";
import type { FrameIRDocument, FrameIRNode } from "./ir/schema";
import { errorMessage } from "./traverse";

export const HEATMAP_FRAME_NAME = "__fos_heatmap__";
const MAX_RECTS = 2000;
const FILL_OPACITY = 0.28;

type Tint = "bound" | "loose" | "blocked";

const TINTS: Record<Tint, RGB> = {
  bound: { r: 0.12, g: 0.73, b: 0.42 },
  loose: { r: 0.93, g: 0.27, b: 0.22 },
  blocked: { r: 0.98, g: 0.71, b: 0.11 },
};

export interface HeatmapResult {
  nodes: number;
  truncated: boolean;
}

/** Removes every overlay frame on the page, whoever created it. */
export function clearStaleOverlays(): number {
  let removed = 0;
  for (const node of figma.currentPage.children) {
    if (node.name === HEATMAP_FRAME_NAME) {
      try {
        node.remove();
        removed++;
      } catch (err) {
        console.log(`[fanos-studio] heatmap cleanup failed: ${errorMessage(err)}`);
      }
    }
  }
  return removed;
}

export function draw(ir: FrameIRDocument): HeatmapResult {
  clearStaleOverlays();

  const tints = tintsByNode(ir);
  const nodes = walkNodes(ir.root).filter((node) => node.geometry.bbox.w > 0 && node.geometry.bbox.h > 0);
  const truncated = nodes.length > MAX_RECTS;
  const drawn = nodes.slice(0, MAX_RECTS);

  const frame = figma.createFrame();
  frame.name = HEATMAP_FRAME_NAME;
  frame.x = ir.root.geometry.bbox.x;
  frame.y = ir.root.geometry.bbox.y;
  frame.resize(Math.max(1, ir.root.geometry.bbox.w), Math.max(1, ir.root.geometry.bbox.h));
  frame.fills = [];
  frame.clipsContent = false;
  frame.expanded = false;
  frame.exportSettings = [];

  for (const node of drawn) {
    const rect = figma.createRectangle();
    rect.name = node.name;
    rect.x = node.geometry.bbox.x - frame.x;
    rect.y = node.geometry.bbox.y - frame.y;
    rect.resize(Math.max(1, node.geometry.bbox.w), Math.max(1, node.geometry.bbox.h));
    rect.fills = [
      { type: "SOLID", color: TINTS[tints.get(node.id) ?? "loose"], opacity: FILL_OPACITY },
    ];
    rect.strokes = [];
    rect.locked = true;
    frame.appendChild(rect);
  }

  // Locked and appended last, so it lands on top and nothing in it is
  // selectable by a stray click.
  figma.currentPage.appendChild(frame);
  frame.locked = true;

  return { nodes: drawn.length, truncated };
}

/**
 * Per-node tint. Blocked wins over loose, which wins over bound: the worst thing
 * true about a node is the thing worth seeing on the canvas.
 */
function tintsByNode(ir: FrameIRDocument): Map<string, Tint> {
  const tints = new Map<string, Tint>();
  const looseNodes = new Set<string>();
  for (const slot of enumerateSlots(ir.root)) {
    if (!slot.bound) looseNodes.add(slot.node.id);
  }

  const blocked = new Set<string>();
  const rootIsLoose = ir.root.layout.mode !== "vertical";
  for (const node of walkNodes(ir.root)) {
    if (node.type === "GROUP") {
      for (const inside of walkNodes(node)) blocked.add(inside.id);
    }
  }
  if (rootIsLoose) blocked.add(ir.root.id);

  for (const node of walkNodes(ir.root)) {
    tints.set(
      node.id,
      blocked.has(node.id) ? "blocked" : looseNodes.has(node.id) ? "loose" : "bound",
    );
  }
  return tints;
}

/** Registered once at startup. Figma fires this on every close path. */
export function registerCleanup(): void {
  figma.on("close", () => {
    clearStaleOverlays();
  });
}

export function nodeCountFor(root: FrameIRNode): number {
  return walkNodes(root).length;
}
