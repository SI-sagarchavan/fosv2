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
 *   Color/core_neu_00                     -> color.core_neu_00     (collection prefix)
 *   Radius/radius_md                      -> radius.md             (collection prefix)
 *   Radius/radius-full                    -> radius.full           (hyphen)
 *
 * The transforms below cover all of them, tried in order. The theme's own
 * NameMap does the final lookup, so the compiler never guesses at a ref that
 * does not exist — an unmapped name comes back undefined and the caller reports
 * it rather than emitting a broken tree.
 */

import type { NormalizedTheme, TokenCategory } from "@fanos/tokens";
import { applyCategoryPrefix, stripCategoryPrefix } from "@fanos/tokens";

/**
 * Spelling variants of one raw name, before any category transform.
 *
 * Figma variables carry the COLLECTION in front of the variable name, and the
 * collection is titlecased by convention: a variable the theme authored as
 * `core_neu_00` arrives as `Color/core_neu_00`, and one authored as `radius_md`
 * arrives as `Radius/radius_md`. The NameMap is an exact-string index, so a
 * case difference is a miss — and a miss on a FILL is not a degraded render,
 * it is a dropped paint. `Color/core_neu_00` failing this lookup is what
 * rendered the fan-preferences card with no plate behind it.
 *
 * Hyphens get the same treatment for the same reason: `radius-full` and
 * `radius_full` are one token spelled two ways, and only one of them is in the
 * map.
 *
 * Lowercasing is safe here BECAUSE the lookup is exact against a map the theme
 * built: a name that only differs by case cannot resolve to the wrong token,
 * it can only stop failing to resolve to the right one.
 */
function spellings(raw: string): string[] {
  const slashed = raw.replace(/\//g, "_").replace(/-/g, "_");
  return [...new Set([slashed, slashed.toLowerCase()])];
}

/** Candidate theme-leaf spellings for a Figma name, most likely first. */
export function candidates(raw: string, category: TokenCategory): string[] {
  const out: string[] = [];
  for (const spelling of spellings(raw)) {
    // Gradients arrive with the stop index appended (`sec/vert_4/0`); colours
    // never do, so this is only tried after the plain forms fail.
    const destopped = spelling.replace(/_\d+$/, "");
    /**
     * The collection prefix, dropped.
     *
     * `stripCategoryPrefix` takes everything up to and including the category
     * word, which is exactly right for a collection-qualified name:
     * `color_core_neu_00` -> `core_neu_00`, `radius_radius_md` -> `radius_md`.
     * It is a no-op for a name that never carried one, so it costs nothing to
     * try on every candidate.
     */
    for (const form of [spelling, destopped]) {
      const stripped = stripCategoryPrefix(form, category);
      out.push(
        form,
        applyCategoryPrefix(form, category),
        stripped,
        applyCategoryPrefix(stripped, category),
      );
    }
  }
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
