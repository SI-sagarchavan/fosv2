/**
 * Figma's token name -> our canonical ref.
 *
 * The IR reports whatever Figma calls the bound variable or style, and that is
 * never quite the theme's leaf name:
 *
 *   background/sec/card                   -> color.background_sec_card
 *   spacing/2_5                           -> space.2_5
 *   15                                    -> space.15          (bare, no prefix)
 *   md                                    -> radius.md
 *   body_md/regular                       -> type.body_md_regular
 *   sec/vert_4/0                          -> gradient.sec_vert_4   (trailing stop index)
 *   button/filled/style_1/surface/default -> color.button_filled_style_1_surface_default
 *
 * Four transforms cover all of them, tried in order. The theme's own NameMap
 * does the final lookup, so the compiler never guesses at a ref that does not
 * exist — an unmapped name comes back undefined and the caller reports it
 * rather than emitting a broken tree.
 */

import type { NormalizedTheme, TokenCategory } from "@fanos/tokens";
import { applyCategoryPrefix } from "@fanos/tokens";

/** Candidate theme-leaf spellings for a Figma name, most likely first. */
export function candidates(raw: string, category: TokenCategory): string[] {
  const slashed = raw.replace(/\//g, "_");
  // Gradients arrive with the stop index appended (`sec/vert_4/0`); colours
  // never do, so this is only tried after the plain forms fail.
  const destopped = slashed.replace(/_\d+$/, "");
  const out = [
    slashed,
    applyCategoryPrefix(slashed, category),
    destopped,
    applyCategoryPrefix(destopped, category),
  ];
  return [...new Set(out)];
}

/**
 * @returns a canonical ref like `color.text_main_high`, or undefined when the
 *          name does not correspond to any token in this theme.
 */
export function canonicalRef(
  theme: NormalizedTheme,
  raw: string | undefined,
  category: TokenCategory,
): string | undefined {
  if (!raw) return undefined;
  for (const key of candidates(raw, category)) {
    const hit = theme.names.toCanonical(key, category);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * A paint ref, which may be a colour OR a gradient.
 *
 * Figma does not say which; `sec/vert_4/0` and `text/main/high` are both just
 * "the bound variable". Colour is tried first because it is far more common,
 * and a gradient name will simply not resolve as one.
 */
export function paintRef(
  theme: NormalizedTheme,
  raw: string | undefined,
): { ref: string; kind: "color" | "gradient" } | undefined {
  const color = canonicalRef(theme, raw, "color");
  if (color) return { ref: color, kind: "color" };
  const gradient = canonicalRef(theme, raw, "gradient");
  if (gradient) return { ref: gradient, kind: "gradient" };
  return undefined;
}
