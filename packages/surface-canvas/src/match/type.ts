/**
 * Typography matching — the full quadruple, exact only.
 *
 * PURE. No Figma import.
 *
 * There is no near-matching type. A 15/22 Montserrat Medium is not "nearly"
 * `body_md` at 16/24; it is a fifth text style that nobody declared, and
 * quietly rounding it into a token would put a lie in the corpus. Either all
 * four properties agree with a style at the current breakpoint or the finding
 * stands with no proposal.
 */
import type { Breakpoint, TypeValue } from "@fanos/tokens";
import { DEFAULT_BREAKPOINTS, type Breakpoints } from "@fanos/tokens";
import { compareTokenNames } from "@fanos/tokens";
import type { TypeEntry } from "../health/types.js";
import type { TextInfo } from "../ir/schema.js";

export interface TypeMatch {
  kind: "exact";
  winner: TypeEntry;
  style: TypeValue;
}

/**
 * Figma stores weight as a style name on the font (`Bold`), and only sometimes
 * as a number. The theme is always numeric, so the names have to be mapped or
 * nothing will ever match.
 */
const WEIGHT_BY_STYLE: Readonly<Record<string, number>> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  regular: 400,
  normal: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
};

/** `SemiBold Italic` -> 600. Italic is a face, not a weight. */
export function resolveWeight(weight: string | number): number | undefined {
  if (typeof weight === "number") return weight;
  const key = weight.toLowerCase().replace(/italic|oblique/g, "").replace(/[\s_-]+/g, "");
  if (key.length === 0) return 400;
  return WEIGHT_BY_STYLE[key];
}

/** The breakpoint a page's type should be checked against, from its own width. */
export function inferBreakpoint(
  width: number,
  breakpoints: Breakpoints = DEFAULT_BREAKPOINTS,
): Breakpoint {
  if (width >= breakpoints.lg) return "desktop";
  if (width >= breakpoints.md) return "tablet";
  return "mobile";
}

export function matchType(
  text: Pick<TextInfo, "fontFamily" | "fontSize" | "fontWeight" | "lineHeight">,
  entries: readonly TypeEntry[],
  breakpoint: Breakpoint,
): TypeMatch | null {
  const weight = resolveWeight(text.fontWeight);
  if (weight === undefined) return null;
  // `auto` line height cannot be compared to a number without guessing the
  // font's own metrics, and a guess here becomes a wrong token downstream.
  if (text.lineHeight === "auto") return null;

  const family = normalizeFamily(text.fontFamily);
  if (family.length === 0) return null;

  const hits = entries.filter((entry) => {
    const style = entry.byBreakpoint[breakpoint];
    if (!style) return false;
    return (
      normalizeFamily(style.family) === family &&
      near(style.size, text.fontSize) &&
      style.weight === weight &&
      near(style.lineHeight, text.lineHeight as number)
    );
  });
  if (hits.length === 0) return null;

  const winner = [...hits].sort(
    (a, b) => a.raw.length - b.raw.length || compareTokenNames(a.ref, b.ref),
  )[0]!;
  return { kind: "exact", winner, style: winner.byBreakpoint[breakpoint]! };
}

/**
 * The IR rounds px to 2 decimals and Figma stores line height as a percentage
 * that rarely lands on an integer, so "exact" is exact to half a pixel. Wider
 * than that and two distinct styles start colliding.
 */
function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.5;
}

function normalizeFamily(family: string): string {
  return family.trim().toLowerCase();
}

/** `16/24 700 Montserrat` — the quadruple, for a finding message. */
export function describeQuadruple(
  text: Pick<TextInfo, "fontFamily" | "fontSize" | "fontWeight" | "lineHeight">,
): string {
  const lh = text.lineHeight === "auto" ? "auto" : String(text.lineHeight);
  return `${text.fontSize}/${lh} ${text.fontWeight} ${text.fontFamily || "(no family)"}`;
}
