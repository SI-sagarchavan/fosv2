/**
 * Colour matching — exact first, then perceptual distance.
 *
 * PURE. No Figma import. See tests/purity.test.ts.
 *
 * The metric is CIE76 (plain Euclidean distance in CIELAB) by default, with
 * CIEDE2000 available. Both are implemented because the choice is not free:
 * CIE76 overstates distance in saturated reds, which is exactly where the
 * reference file's brand colour sits. The README carries the measured table for
 * both. What matters structurally is that near matches are *ranked* and never
 * bulk-applied, so the cost of the metric being slightly wrong is one extra
 * swatch in a review list rather than 36 layers silently repainted.
 */
import { compareTokenNames, hexToRgb } from "@fanos/tokens";
import type { ColorEntry, FixCandidate } from "../health/types.js";
import { isBindable } from "../health/types.js";

export type ColorMetric = "cie76" | "ciede2000";

export interface ColorMatchOptions {
  metric: ColorMetric;
  /** Upper bound for a "near" match. Above it, no proposal at all. */
  threshold: number;
  maxCandidates: number;
}

export interface ColorMatch {
  kind: "exact" | "near";
  winner: ColorEntry;
  distance: number;
  /** Ranked, deduped by hex, capped. Index 0 is the winner. */
  candidates: Array<{ entry: ColorEntry; distance: number }>;
}

/** A solid colour parsed out of an IR `raw` string. */
export interface ParsedSolid {
  hex: string;
  /** 0-1. Figma paint opacity rides alongside the colour variable, so a */
  /** translucent white still binds exactly to `color.core_neu_00`.        */
  alpha: number;
}

const HEX_RE = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;

/**
 * IR `raw` is `#rrggbb`, `#rrggbbaa`, `IMAGE:FILL`, `MIXED`, or
 * `GRADIENT_LINEAR(...)`. Only the first two are matchable.
 */
export function parseSolid(raw: string | undefined): ParsedSolid | null {
  if (!raw) return null;
  const m = HEX_RE.exec(raw.trim());
  if (!m) return null;
  const alpha = m[2] === undefined ? 1 : Number.parseInt(m[2], 16) / 255;
  return { hex: `#${m[1]!.toLowerCase()}`, alpha };
}

/** True when two hex strings are the same colour, allowing 1/255 alpha rounding. */
export function sameSolid(a: string, b: string): boolean {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const left = parseSolid(a);
  const right = parseSolid(b);
  if (!left || !right) return false;
  return left.hex === right.hex && Math.abs(left.alpha - right.alpha) < 1 / 255 + 1e-6;
}

export function isGradient(raw: string | undefined): boolean {
  return raw !== undefined && raw.startsWith("GRADIENT_");
}

/**
 * `core_prim_400` -> `core_prim`; `text_main_high` -> `text_main_high`.
 *
 * Only a trailing numeric step is dropped. A ramp shares a family; a semantic
 * alias is its own family, which is what keeps `background_prim_card` out of a
 * candidate list for a raw brand red.
 */
export function colorFamily(raw: string): string {
  return raw.replace(/_\d+$/, "");
}

export function matchColor(
  raw: string | undefined,
  colors: readonly ColorEntry[],
  options: ColorMatchOptions,
): ColorMatch | null {
  const solid = parseSolid(raw);
  if (!solid) return null;

  const scored = colors.map((entry) => ({
    entry,
    distance: deltaE(solid.hex, entry.hex, options.metric),
  }));

  const exact = scored.filter((s) => s.entry.hex.toLowerCase() === solid.hex);
  if (exact.length > 0) {
    const winner = pickPreferred(exact.map((s) => s.entry));
    return { kind: "exact", winner, distance: 0, candidates: [{ entry: winner, distance: 0 }] };
  }

  const under = scored.filter((s) => s.distance < options.threshold);
  if (under.length === 0) return null;

  // Scope to the single nearest family. Mixing ramps produces a candidate list
  // that looks thorough and is actually noise.
  const byFamily = new Map<string, Array<{ entry: ColorEntry; distance: number }>>();
  for (const s of under) {
    const key = s.entry.family;
    const bucket = byFamily.get(key);
    if (bucket) bucket.push(s);
    else byFamily.set(key, [s]);
  }
  let best: Array<{ entry: ColorEntry; distance: number }> | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const bucket of byFamily.values()) {
    const min = Math.min(...bucket.map((s) => s.distance));
    if (min < bestDistance) {
      bestDistance = min;
      best = bucket;
    }
  }

  const candidates = dedupeByHex(best ?? []).slice(0, options.maxCandidates);
  const winner = candidates[0];
  if (!winner) return null;
  return { kind: "near", winner: winner.entry, distance: winner.distance, candidates };
}

/**
 * The palette has 163 colour tokens over 61 distinct hexes — `#ffffff` alone is
 * nine tokens. Showing nine identical swatches is not a choice, it is a wall, so
 * one token per hex survives.
 */
function dedupeByHex(
  scored: ReadonlyArray<{ entry: ColorEntry; distance: number }>,
): Array<{ entry: ColorEntry; distance: number }> {
  const byHex = new Map<string, Array<{ entry: ColorEntry; distance: number }>>();
  for (const s of scored) {
    const key = s.entry.hex.toLowerCase();
    const bucket = byHex.get(key);
    if (bucket) bucket.push(s);
    else byHex.set(key, [s]);
  }
  const out: Array<{ entry: ColorEntry; distance: number }> = [];
  for (const bucket of byHex.values()) {
    const winner = pickPreferred(bucket.map((s) => s.entry));
    out.push({ entry: winner, distance: bucket[0]!.distance });
  }
  out.sort(
    (a, b) => a.distance - b.distance || compareTokenNames(a.entry.ref, b.entry.ref),
  );
  return out;
}

/**
 * Deterministic winner among tokens that share a value.
 *
 * `core_` first: the core ramp is the palette, the rest are semantic aliases
 * pointing at it. Binding a loose `#ffffff` to `core_neu_00` states a colour;
 * binding it to `background_main_surface` states an intent the tool cannot
 * actually read off a hex.
 */
export function pickPreferred(entries: readonly ColorEntry[]): ColorEntry {
  return [...entries].sort(
    (a, b) =>
      coreRank(a.raw) - coreRank(b.raw) ||
      a.raw.length - b.raw.length ||
      compareTokenNames(a.ref, b.ref),
  )[0]!;
}

function coreRank(raw: string): number {
  return raw.startsWith("core_") ? 0 : 1;
}

export function toCandidates(
  scored: ReadonlyArray<{ entry: ColorEntry; distance: number }>,
): FixCandidate[] {
  return scored.map((s) => ({
    tokenRef: s.entry.ref,
    distance: round(s.distance, 2),
    value: s.entry.hex,
    bindable: isBindable(s.entry),
  }));
}

// ---------------------------------------------------------------------------
// ΔE
// ---------------------------------------------------------------------------

export type Lab = [number, number, number];

/** sRGB -> CIELAB, D65, the same white point the CSS spec assumes. */
export function hexToLab(hex: string): Lab {
  const rgb = hexToRgb(hex);
  if (!rgb) return [0, 0, 0];
  const [r, g, b] = rgb.map((c) => linearize(c / 255)) as [number, number, number];

  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;

  const fx = pivot(x);
  const fy = pivot(y);
  const fz = pivot(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function linearize(u: number): number {
  return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
}

function pivot(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29;
}

export function deltaE(a: string, b: string, metric: ColorMetric): number {
  return metric === "ciede2000" ? deltaE2000(a, b) : deltaE76(a, b);
}

export function deltaE76(a: string, b: string): number {
  const [l1, a1, b1] = hexToLab(a);
  const [l2, a2, b2] = hexToLab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

/** CIEDE2000, kL = kC = kH = 1. */
export function deltaE2000(a: string, b: string): number {
  const [L1, a1, b1] = hexToLab(a);
  const [L2, a2, b2] = hexToLab(b);

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Cbar ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 25 ** 7)));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  const h1p = hueAngle(b1, a1p);
  const h2p = hueAngle(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp: number;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
  else dhp = h2p - h1p + 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp) / 2);

  const Lbar = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let hbarp: number;
  if (C1p * C2p === 0) hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
  else hbarp = (h1p + h2p - 360) / 2;

  const T =
    1 -
    0.17 * Math.cos(rad(hbarp - 30)) +
    0.24 * Math.cos(rad(2 * hbarp)) +
    0.32 * Math.cos(rad(3 * hbarp + 6)) -
    0.2 * Math.cos(rad(4 * hbarp - 63));

  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Cbarp7 = Cbarp ** 7;
  const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;

  return Math.sqrt(
    (dLp / Sl) ** 2 +
      (dCp / Sc) ** 2 +
      (dHp / Sh) ** 2 +
      Rt * (dCp / Sc) * (dHp / Sh),
  );
}

function hueAngle(b: number, ap: number): number {
  if (ap === 0 && b === 0) return 0;
  const deg = (Math.atan2(b, ap) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
