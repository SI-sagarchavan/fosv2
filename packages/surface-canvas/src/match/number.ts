/**
 * Numeric scale matching — spacing and radius.
 *
 * PURE. No Figma import.
 *
 * Exact means exact: 10 is `space.2_5` and nothing else. Near means within a
 * couple of pixels, which is the range where a designer nudged a value by hand
 * and meant the token. Beyond that there is no proposal, because a 27px gap is
 * not a mis-typed 24 — it is a decision nobody has made yet.
 */
import { compareTokenNames } from "@fanos/tokens";
import type { FixCandidate, NumberEntry } from "../health/types.js";
import { isBindable } from "../health/types.js";

export interface NumberMatchOptions {
  /** px window for a near match. */
  nearWithin: number;
  maxCandidates: number;
}

export interface NumberMatch {
  kind: "exact" | "near";
  winner: NumberEntry;
  /** Absolute px delta. 0 for exact. */
  distance: number;
  candidates: Array<{ entry: NumberEntry; distance: number }>;
}

const EPSILON = 1e-6;

export function matchNumber(
  value: number,
  entries: readonly NumberEntry[],
  options: NumberMatchOptions,
): NumberMatch | null {
  const scored = entries.map((entry) => ({
    entry,
    distance: Math.abs(entry.px - value),
  }));

  const exact = scored.filter((s) => s.distance < EPSILON);
  if (exact.length > 0) {
    const winner = pickPreferred(exact.map((s) => s.entry));
    return { kind: "exact", winner, distance: 0, candidates: [{ entry: winner, distance: 0 }] };
  }

  const near = scored
    .filter((s) => s.distance <= options.nearWithin)
    .sort((a, b) => a.distance - b.distance || compareTokenNames(a.entry.ref, b.entry.ref))
    .slice(0, options.maxCandidates);

  const winner = near[0];
  if (!winner) return null;
  return { kind: "near", winner: winner.entry, distance: winner.distance, candidates: near };
}

/** Two tokens with the same px value: shortest raw name, then deterministic. */
export function pickPreferred(entries: readonly NumberEntry[]): NumberEntry {
  return [...entries].sort(
    (a, b) => a.raw.length - b.raw.length || compareTokenNames(a.ref, b.ref),
  )[0]!;
}

/** `10px === space.2_5` / `13px, nearest is space.3 (12)`. */
export function numberEvidence(value: number, match: NumberMatch): string {
  if (match.kind === "exact") return `${format(value)}px === ${match.winner.ref}`;
  return `${format(value)}px, nearest is ${match.winner.ref} (${format(match.winner.px)})`;
}

export function toCandidates(
  scored: ReadonlyArray<{ entry: NumberEntry; distance: number }>,
): FixCandidate[] {
  return scored.map((s) => ({
    tokenRef: s.entry.ref,
    distance: Math.round(s.distance * 100) / 100,
    value: `${format(s.entry.px)}px`,
    bindable: isBindable(s.entry),
  }));
}

/**
 * A non-integer spacing or radius is drift from a scaled frame, not a design
 * decision — it gets its own rule (F7) and never a token proposal.
 */
export function isSubpixel(value: number): boolean {
  return Number.isFinite(value) && !Number.isInteger(value);
}

export function format(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}
