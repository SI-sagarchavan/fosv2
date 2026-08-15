/**
 * Shadow matching — F6.
 *
 * PURE. No Figma import.
 *
 * Exact only, like type. A shadow is a composite (offset, blur, spread, colour,
 * opacity, inset) and a near miss on any axis is a different elevation, not a
 * nudge. LAYER_BLUR / BACKGROUND_BLUR have no token to match.
 */
import { compareTokenNames } from "@fanos/tokens";
import type { ShadowEntry } from "../health/types.js";
import { isBindable } from "../health/types.js";

const PX = 0.51;
const OPACITY = 1;

export interface EffectGeometry {
  type: string;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
  /** 0–100. */
  opacity: number;
  inset: boolean;
}

export interface EffectMatch {
  winner: ShadowEntry;
}

export function hasEffectGeometry(
  value: Partial<EffectGeometry> | null | undefined,
): value is EffectGeometry {
  if (!value) return false;
  return (
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.blur === "number" &&
    typeof value.spread === "number" &&
    typeof value.color === "string" &&
    typeof value.opacity === "number" &&
    typeof value.inset === "boolean"
  );
}

/** Batching key: same elevation, one row. */
export function fingerprintEffect(geo: EffectGeometry): string {
  const kind = geo.inset ? "inner-shadow" : "drop-shadow";
  return `${kind} ${fmt(geo.x)} ${fmt(geo.y)} ${fmt(geo.blur)} ${fmt(geo.spread)} ${geo.color.toLowerCase()}@${fmt(geo.opacity)}`;
}

export function matchEffect(
  geo: EffectGeometry,
  entries: readonly ShadowEntry[],
): EffectMatch | null {
  if (geo.type === "LAYER_BLUR" || geo.type === "BACKGROUND_BLUR") return null;

  const hits = entries.filter((entry) => sameShadow(geo, entry));
  if (hits.length === 0) return null;

  const bindable = hits.filter((entry) => isBindable(entry));
  const pool = bindable.length > 0 ? bindable : hits;
  const winner = [...pool].sort((a, b) => compareTokenNames(a.ref, b.ref))[0]!;
  return { winner };
}

function sameShadow(geo: EffectGeometry, entry: ShadowEntry): boolean {
  if (entry.inset !== geo.inset) return false;
  if (!near(entry.x, geo.x, PX)) return false;
  if (!near(entry.y, geo.y, PX)) return false;
  if (!near(entry.blur, geo.blur, PX)) return false;
  if (!near(entry.spread, geo.spread, PX)) return false;
  if (entry.color.toLowerCase() !== geo.color.toLowerCase()) return false;
  return near(entry.opacity, geo.opacity, OPACITY);
}

function near(a: number, b: number, epsilon: number): boolean {
  return Math.abs(a - b) <= epsilon;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}
