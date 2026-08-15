/**
 * The score.
 *
 * PURE. No Figma import.
 *
 * Coverage is a count over {@link enumerateSlots} and nothing else, and
 * "one click away" is a count over the batches the queue is actually offering.
 * Both numbers therefore come from the same denominator by construction — the
 * bar can never claim a gain the queue cannot deliver.
 */
import { enumerateSlots, type Slot } from "./slots.js";
import type { FrameIRNode } from "../ir/schema.js";
import type { SlotKind } from "./types.js";

export interface KindTally {
  total: number;
  bound: number;
  loose: number;
}

export interface CoverageStats {
  total: number;
  bound: number;
  loose: number;
  /** bound / total, as a percentage to one decimal. */
  percent: number;
  /** Loose slots sitting in a safe batch — exact match, token is bindable. */
  oneClickAway: number;
  /** oneClickAway / total, to one decimal. */
  oneClickPercent: number;
  /** What coverage would read after applying every safe batch. */
  projectedPercent: number;
  byKind: Record<SlotKind, KindTally>;
}

const KINDS: SlotKind[] = ["fill", "stroke", "gap", "padding", "radius", "text", "effect"];

export function emptyTally(): Record<SlotKind, KindTally> {
  const out = {} as Record<SlotKind, KindTally>;
  for (const kind of KINDS) out[kind] = { total: 0, bound: 0, loose: 0 };
  return out;
}

export function computeCoverage(root: FrameIRNode, oneClickAway = 0): CoverageStats {
  return coverageFromSlots(enumerateSlots(root), oneClickAway);
}

export function coverageFromSlots(slots: readonly Slot[], oneClickAway = 0): CoverageStats {
  const byKind = emptyTally();
  let bound = 0;

  for (const slot of slots) {
    const tally = byKind[slot.kind];
    tally.total++;
    if (slot.bound) {
      tally.bound++;
      bound++;
    } else {
      tally.loose++;
    }
  }

  const total = slots.length;
  const loose = total - bound;
  return {
    total,
    bound,
    loose,
    percent: percent(bound, total),
    oneClickAway,
    oneClickPercent: percent(oneClickAway, total),
    projectedPercent: percent(bound + oneClickAway, total),
    byKind,
  };
}

/** One decimal, because the panel shows one decimal. 1339/2485 -> 53.9. */
export function percent(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}
