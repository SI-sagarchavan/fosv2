/**
 * Slots — the unit both the score and the fix queue are counted in.
 *
 * PURE. No Figma import.
 *
 * This module is the single definition of "a thing that can be bound". The
 * coverage bar and the fix queue are both derived from it, which is the whole
 * point: a panel where the headline number and the list of levers are computed
 * independently is a panel that will eventually contradict itself in front of a
 * designer.
 *
 * The rules, in one place:
 *
 *   fill / stroke / text / effect  a slot when present; bound when the IR found
 *                                 a variable or a style behind it
 *   radius                         a slot whenever the node can have one —
 *                                 INCLUDING zero, because `radius.none` exists
 *                                 and a bound zero is a decision while a loose
 *                                 zero is an accident that reads the same
 *   gap / padding                  a slot only when non-zero; absent spacing is
 *                                 not a hardcoded value, it is no value
 *
 * The zero asymmetry is deliberate and it is the one place this differs from
 * `countBindings` in the exporter, which skips zero radius too. See README.
 */
import type { FrameIRDocument, FrameIRNode } from "../ir/schema.js";
import type { SlotKind } from "./types.js";

export interface Slot {
  node: FrameIRNode;
  kind: SlotKind;
  /** `layout.padding.top`, `fill`, `effects.0`. */
  propPath: string;
  bound: boolean;
  /** Numeric slots only. */
  value?: number;
  /** Paint slots only — the verbatim IR `raw`. */
  raw?: string;
  /** Effect slots only. */
  effectIndex?: number;
  effectType?: string;
}

/** Depth-first, parents before children, deterministic sibling order. */
export function walkNodes(root: FrameIRNode): FrameIRNode[] {
  const out: FrameIRNode[] = [];
  const stack: FrameIRNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  return out;
}

export const PADDING_SIDES = ["top", "right", "bottom", "left"] as const;
export type PaddingSide = (typeof PADDING_SIDES)[number];

/**
 * Eight of the eleven rules enumerate slots, and each pass walks every node.
 * The tree is immutable FOR THE DURATION OF ONE LINT, so the walk is memoized
 * per root object — one traversal per lint instead of eight.
 *
 * The dangerous case, and the reason {@link invalidateSlots} exists: an
 * incremental re-lint patches a subtree in place and hands back the SAME root
 * object. That hits the cache and returns the slots from before the edit, so the
 * score cannot move — a designer binds a variable, the panel re-lints, and the
 * percentage sits there unchanged until a full refresh rebuilds the tree.
 * Anything that mutates a cached tree must invalidate it.
 */
const slotCache = new WeakMap<FrameIRNode, Slot[]>();

export function enumerateSlots(root: FrameIRNode): Slot[] {
  const cached = slotCache.get(root);
  if (cached) return cached;
  const slots = collectSlots(root);
  slotCache.set(root, slots);
  return slots;
}

/** Drops the memoized walk for `root`. Call after mutating the tree under it. */
export function invalidateSlots(root: FrameIRNode): void {
  slotCache.delete(root);
}

function collectSlots(root: FrameIRNode): Slot[] {
  const slots: Slot[] = [];
  for (const node of walkNodes(root)) {
    if (node.fill) {
      slots.push({
        node,
        kind: "fill",
        propPath: "fill",
        bound: !node.fill.unbound,
        raw: node.fill.raw,
      });
    }
    if (node.stroke) {
      slots.push({
        node,
        kind: "stroke",
        propPath: "stroke",
        bound: !node.stroke.unbound,
        raw: node.stroke.raw,
      });
    }
    if (node.radius) {
      slots.push({
        node,
        kind: "radius",
        propPath: "radius",
        // Not `!unbound`: the IR reports a zero radius as bound-by-default, and
        // for coverage purposes an unbound zero is still an unmade decision.
        bound: node.radius.tokenRef !== undefined,
        value: node.radius.value,
      });
    }
    if (node.layout.gap && node.layout.gap.value !== 0) {
      slots.push({
        node,
        kind: "gap",
        propPath: "layout.gap",
        bound: node.layout.gap.tokenRef !== undefined,
        value: node.layout.gap.value,
      });
    }
    for (const side of PADDING_SIDES) {
      const pad = node.layout.padding[side];
      if (pad.value === 0) continue;
      slots.push({
        node,
        kind: "padding",
        propPath: `layout.padding.${side}`,
        bound: pad.tokenRef !== undefined,
        value: pad.value,
      });
    }
    for (let i = 0; i < node.effects.length; i++) {
      const effect = node.effects[i]!;
      slots.push({
        node,
        kind: "effect",
        propPath: `effects.${i}`,
        bound: !effect.unbound,
        effectIndex: i,
        effectType: effect.type,
      });
    }
    if (node.text) {
      slots.push({
        node,
        kind: "text",
        propPath: "text",
        bound: !node.text.unbound,
      });
    }
  }
  return slots;
}

export function looseSlots(root: FrameIRNode): Slot[] {
  return enumerateSlots(root).filter((slot) => !slot.bound);
}

/** `layout.padding.top` -> `paddingTop`, the Figma field name. */
export function paddingFieldFor(side: PaddingSide): "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft" {
  switch (side) {
    case "top":
      return "paddingTop";
    case "right":
      return "paddingRight";
    case "bottom":
      return "paddingBottom";
    case "left":
      return "paddingLeft";
  }
}

export function paddingSideOf(propPath: string): PaddingSide | undefined {
  const side = propPath.slice("layout.padding.".length);
  return (PADDING_SIDES as readonly string[]).includes(side) ? (side as PaddingSide) : undefined;
}

export function slotsOf(ir: FrameIRDocument): Slot[] {
  return enumerateSlots(ir.root);
}
