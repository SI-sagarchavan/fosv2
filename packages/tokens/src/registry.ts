/**
 * Part 6 — Runtime registry.
 *
 * `search` and `describe` exist so the codegen agent can query tokens as a TOOL
 * instead of carrying 163 colours in its context. Every response is deliberately
 * compact: a ref, a one-line value, and the CSS var. Nothing here returns a
 * blob.
 */

import type { Category, NormalizedTheme, Scope, TokenCategory, TokenValue } from "./types.js";
import { BREAKPOINTS, TOKEN_CATEGORIES } from "./types.js";
import { compareTokenNames, typeIntersection } from "./normalize.js";
import { cssVar as cssVarOf, parseRef, refExists, resolveRef } from "./refs.js";
import { formatNumber } from "./color.js";
import { coalesceStops } from "./gradient.js";
import type { SurfaceSet } from "./raw-schema.js";
import { DURATION_LEAVES, EASING_LEAVES } from "./motion.js";

export const SEARCH_LIMIT = 20;

export interface TokenDescription {
  ref: string;
  category: Category;
  /** The designer-facing raw name, e.g. `drop_shadow_md`. Undefined for surfaces and assets. */
  raw: string | undefined;
  /** One-line rendering of the value, sized for an agent's context window. */
  value: string;
  cssVar: string;
}

export interface Registry {
  readonly theme: NormalizedTheme;
  has(ref: string): boolean;
  resolve(ref: string): TokenValue | undefined;
  list(category: Category): string[];
  /** Fuzzy, ranked, capped at {@link SEARCH_LIMIT}. */
  search(query: string): string[];
  cssVar(ref: string): string;
  describe(ref: string): TokenDescription | undefined;
}

export interface RegistryOptions {
  surfaces?: SurfaceSet;
  /** Which palette `resolve` reads. `dark` falls back to `light` per token. */
  scope?: Scope;
}

export function createRegistry(theme: NormalizedTheme, options: RegistryOptions = {}): Registry {
  const scope: Scope = options.scope ?? "light";
  const surfaces = options.surfaces;

  const byCategory = new Map<Category, string[]>();
  const put = (category: Category, leaves: Iterable<string>) => {
    byCategory.set(
      category,
      [...leaves].sort(compareTokenNames).map((leaf) => `${category}.${leaf}`),
    );
  };
  put("space", theme.space.keys());
  put("radius", theme.radius.keys());
  put("opacity", theme.opacity.keys());
  put("color", theme.color.light.keys());
  put("gradient", theme.gradient.light.keys());
  put("shadow", theme.shadow.light.keys());
  // Only the breakpoint-complete styles are listed. A partial style is not a
  // token an agent may emit — see E1.
  put("type", typeIntersection(theme));
  put("surface", surfaces?.surfaces.keys() ?? []);
  put("asset", surfaces?.assets.keys() ?? []);
  // Built-in motion scale — always present, independent of the theme export.
  put("duration", DURATION_LEAVES);
  put("easing", EASING_LEAVES);
  put("motion", ["reducedPolicy"]);

  const all = [...byCategory.values()].flat();

  return {
    theme,
    has: (ref) => refExists(theme, ref, surfaces, scope),
    resolve: (ref) => resolveRef(theme, ref, scope),
    list: (category) => byCategory.get(category) ?? [],
    search: (query) => search(all, query),
    cssVar: (ref) => cssVarOf(ref),
    describe: (ref) => describe(theme, ref, scope, surfaces),
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Subsequence match with a score that prefers, in order: an exact ref, a prefix
 * of the leaf, a contiguous substring, then a scattered subsequence. Ties break
 * on shorter refs first, then deterministically by name.
 *
 * Separators in the query are ignored, so `sec500`, `sec-500` and `sec_500` all
 * find `color.core_sec_500` — an agent should not have to guess the punctuation.
 */
export function search(refs: readonly string[], query: string, limit = SEARCH_LIMIT): string[] {
  const q = query.trim().toLowerCase().replace(/[\s_.\-/]+/g, "");
  if (q.length === 0) return [];

  const scored: Array<{ ref: string; score: number }> = [];
  for (const ref of refs) {
    const score = scoreRef(ref, q, query.trim().toLowerCase());
    if (score > 0) scored.push({ ref, score });
  }
  scored.sort((a, b) => b.score - a.score || a.ref.length - b.ref.length || compareTokenNames(a.ref, b.ref));
  return scored.slice(0, limit).map((s) => s.ref);
}

function scoreRef(ref: string, squashedQuery: string, rawQuery: string): number {
  const lower = ref.toLowerCase();
  const leaf = lower.slice(lower.indexOf(".") + 1);
  const squashedRef = lower.replace(/[\s_.\-/]+/g, "");
  const squashedLeaf = leaf.replace(/[\s_.\-/]+/g, "");

  if (lower === rawQuery) return 1000;
  if (leaf === squashedQuery || squashedLeaf === squashedQuery) return 900;
  if (squashedLeaf.startsWith(squashedQuery)) return 800 - squashedLeaf.length;
  if (squashedRef.startsWith(squashedQuery)) return 700 - squashedRef.length;
  if (squashedLeaf.includes(squashedQuery)) return 600 - squashedLeaf.length;
  if (squashedRef.includes(squashedQuery)) return 500 - squashedRef.length;
  if (isSubsequence(squashedQuery, squashedRef)) return 300 - squashedRef.length;
  return 0;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

// ---------------------------------------------------------------------------
// Describe
// ---------------------------------------------------------------------------

function describe(
  theme: NormalizedTheme,
  ref: string,
  scope: Scope,
  surfaces: SurfaceSet | undefined,
): TokenDescription | undefined {
  const parsed = parseRef(ref);
  if (!parsed) return undefined;
  const { category, leaf } = parsed;

  if (category === "surface") {
    if (!surfaces?.surfaces.has(leaf)) return undefined;
    const surface = surfaces.surfaces.get(leaf)!;
    const bits = [
      `${(surface.layers ?? []).length} layers`,
      `${(surface.borders ?? []).length} borders`,
      ...(surface.radius ? [surface.radius] : []),
      ...(surface.shadow ? [surface.shadow] : []),
    ];
    return { ref, category, raw: undefined, value: bits.join(", "), cssVar: cssVarOf(ref) };
  }

  if (category === "asset") {
    const url = surfaces?.assets.get(leaf);
    // Assets may resolve via resolveAsset without an entry in the surfaces map.
    if (url === undefined) {
      return { ref, category, raw: undefined, value: leaf, cssVar: cssVarOf(ref) };
    }
    return { ref, category, raw: undefined, value: url, cssVar: cssVarOf(ref) };
  }

  const value = resolveRef(theme, ref, scope);
  if (!value) return undefined;
  const tokenCat = (TOKEN_CATEGORIES as readonly string[]).includes(category)
    ? (category as TokenCategory)
    : undefined;
  return {
    ref,
    category,
    raw: tokenCat ? theme.names.toRaw(ref, tokenCat) : undefined,
    value: renderValue(value),
    cssVar: cssVarOf(ref),
  };
}

function renderValue(value: TokenValue): string {
  switch (value.category) {
    case "space":
    case "radius":
      return `${formatNumber(value.px)}px`;
    case "opacity":
      return `${formatNumber(value.percent)}% (${formatNumber(value.unit)})`;
    case "color":
      return `${value.hex} (rgb ${value.rgb.join(" ")})`;
    case "gradient": {
      const stops = coalesceStops(value.gradient.stops)
        .map((s) => `${s.color}@${formatNumber(s.opacity)}%/${formatNumber(s.percent)}%`)
        .join(" ");
      return `linear ${formatNumber(value.gradient.degree)}deg ${stops}`;
    }
    case "shadow": {
      const s = value.shadow;
      return `${s.inset ? "inset " : ""}${formatNumber(s.x)} ${formatNumber(s.y)} ${formatNumber(s.blur)} ${formatNumber(s.spread)} ${s.color}@${formatNumber(s.opacity)}%`;
    }
    case "type": {
      const parts: string[] = [];
      for (const bp of BREAKPOINTS) {
        const style = value.byBreakpoint[bp];
        if (!style) continue;
        parts.push(
          `${bp} ${formatNumber(style.size)}/${formatNumber(style.lineHeight)} ${formatNumber(style.weight)} ${style.family}`,
        );
      }
      return parts.join("; ");
    }
    case "duration":
      return `${formatNumber(value.ms)}ms`;
    case "easing":
      return value.curve;
    case "motion":
      return value.policy;
  }
}

