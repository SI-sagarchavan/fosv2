/**
 * Colour helpers. Pure, no dependencies.
 *
 * Everything here exists to serve one CSS requirement: every colour must emit
 * both a hex var and a space-separated `r g b` triplet var, because surfaces
 * composite with `rgb(var(--x-rgb) / 20%)` and the token file has no alpha
 * variants.
 */

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const HEX3 = /^#[0-9a-fA-F]{3}$/;
const HEX8 = /^#[0-9a-fA-F]{8}$/;

export type Rgb = [number, number, number];

export function isValidHex(value: string): boolean {
  return HEX6.test(value) || HEX3.test(value) || HEX8.test(value);
}

/**
 * Normalize to lowercase `#rrggbb`. Expands `#abc`, drops the alpha byte of
 * `#rrggbbaa` (alpha lives in the opacity scale, never in a colour token).
 * Returns undefined for anything malformed — callers turn that into E5.
 */
export function normalizeHex(value: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (HEX6.test(v)) return v.toLowerCase();
  if (HEX8.test(v)) return v.slice(0, 7).toLowerCase();
  if (HEX3.test(v)) {
    const [r, g, b] = [v[1]!, v[2]!, v[3]!];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return undefined;
}

export function hexToRgb(hex: string): Rgb | undefined {
  const n = normalizeHex(hex);
  if (!n) return undefined;
  return [
    Number.parseInt(n.slice(1, 3), 16),
    Number.parseInt(n.slice(3, 5), 16),
    Number.parseInt(n.slice(5, 7), 16),
  ];
}

/** `#2939a3` -> `41 57 163`, the modern space-separated form. */
export function rgbTriplet(hex: string): string | undefined {
  const rgb = hexToRgb(hex);
  return rgb ? rgb.join(" ") : undefined;
}

/**
 * `rgb(26 26 26 / 100%)` — the one colour form this package emits inline.
 * Percent is rendered as an integer when it is one, so output stays byte-stable.
 */
export function rgbaFn(hex: string, opacityPercent: number): string {
  const rgb = hexToRgb(hex) ?? [0, 0, 0];
  return `rgb(${rgb.join(" ")} / ${formatPercent(opacityPercent)}%)`;
}

/** Same, but referencing the colour's `-rgb` var instead of inlining the value. */
export function rgbaVarFn(rgbVarName: string, opacityPercent: number): string {
  return `rgb(var(${rgbVarName}) / ${formatPercent(opacityPercent)}%)`;
}

/** Deterministic number rendering: no exponent, no trailing zeros, no `-0`. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Object.is(n, -0)) return "0";
  if (Number.isInteger(n)) return String(n);
  // 4dp is well past what any token needs and keeps float noise out of the output.
  return String(Number.parseFloat(n.toFixed(4)));
}

export function formatPercent(n: number): string {
  return formatNumber(n);
}

/** 40 -> `0.4`, 100 -> `1`, 0 -> `0`. */
export function opacityToUnit(percent: number): number {
  return Number.parseFloat((percent / 100).toFixed(4));
}
