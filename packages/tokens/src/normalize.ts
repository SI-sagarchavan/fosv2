/**
 * Part 1 — Normalization.
 *
 * Raw token names embed their own category and sometimes a redundant suffix.
 * This module turns them into a clean dotted vocabulary and back again.
 *
 * PURE. No filesystem, no process, no I/O of any kind — the tests import this
 * module directly and run against in-memory objects.
 *
 * The raw names are the contract with Figma and are never renamed. The
 * reverse direction matters as much as the forward one: the Figma IR extractor
 * reads `boundVariables` and gets ORIGINAL names, then has to land on a
 * canonical ref.
 */

import type {
  Breakpoint,
  GradientValue,
  NameMap,
  NameMapEntry,
  NormalizedTheme,
  RawGradient,
  RawShadow,
  RawTypography,
  Scope,
  ShadowValue,
  TokenCategory,
  TypeValue,
} from "./types.js";
import { BREAKPOINTS, SCOPES, TOKEN_CATEGORIES } from "./types.js";
import { normalizeHex } from "./color.js";

// ---------------------------------------------------------------------------
// Section <-> category
// ---------------------------------------------------------------------------

/** Raw top-level section name -> canonical category. */
export const SECTION_TO_CATEGORY: Readonly<Record<string, TokenCategory>> = {
  spacing: "space",
  radius: "radius",
  color: "color",
  opacity: "opacity",
  gradient: "gradient",
  shadow: "shadow",
  typography_mobile: "type",
  typography_tablet: "type",
  typography_desktop: "type",
};

/**
 * The word that appears inside raw leaf names for each category. Note this is
 * the RAW word, not the canonical one: `space` tokens are named `spacing_*`.
 */
const CATEGORY_RAW_WORD: Readonly<Record<TokenCategory, string>> = {
  space: "spacing",
  radius: "radius",
  color: "color",
  opacity: "opacity",
  gradient: "gradient",
  shadow: "shadow",
  type: "typography",
};

/** `typography_desktop` -> `desktop`. */
export function sectionBreakpoint(section: string): Breakpoint | undefined {
  const bp = section.startsWith("typography_") ? section.slice("typography_".length) : undefined;
  return (BREAKPOINTS as readonly string[]).includes(bp ?? "") ? (bp as Breakpoint) : undefined;
}

// ---------------------------------------------------------------------------
// Leaf name rules
// ---------------------------------------------------------------------------

/**
 * Strip the category word — and everything before it — from a raw leaf name,
 * then strip the redundant trailing `_gradient`.
 *
 *   spacing_4                    space     -> 4
 *   spacing_0_5                  space     -> 0_5
 *   radius_2xl                   radius    -> 2xl
 *   radius_rounded               radius    -> rounded
 *   core_sec_500                 color     -> core_sec_500   (no `color` segment)
 *   gradient_nue_vert_1_gradient gradient  -> nue_vert_1
 *   drop_shadow_md               shadow    -> md             (word is not leading)
 *   dp_2_regular                 type      -> dp_2_regular   (no `typography` segment)
 *
 * The category word is matched as a whole underscore-delimited segment, and
 * never consumed when it is the final segment — a token literally named
 * `foo_shadow` keeps its name rather than normalizing to the empty string.
 */
export function stripCategoryPrefix(leaf: string, category: TokenCategory): string {
  const word = CATEGORY_RAW_WORD[category];
  let segments = leaf.split("_");
  const idx = segments.indexOf(word);
  if (idx >= 0 && idx < segments.length - 1) segments = segments.slice(idx + 1);
  let out = segments.join("_");
  if (category === "gradient") out = out.replace(/_gradient$/, "");
  return out;
}

/** Inverse of {@link stripCategoryPrefix}, using each category's default raw pattern. */
export function applyCategoryPrefix(leaf: string, category: TokenCategory): string {
  switch (category) {
    case "space":
      return `spacing_${leaf}`;
    case "radius":
      return `radius_${leaf}`;
    case "opacity":
      return `opacity_${leaf}`;
    case "gradient":
      return `gradient_${leaf}_gradient`;
    // Shadows are the one lossy direction: `drop_shadow_md` and a hypothetical
    // `inner_shadow_md` both normalize to `shadow.md`. `drop` is the default
    // because it is the only prefix the export has ever contained; use the
    // theme's NameMap when the exact authored name matters.
    case "shadow":
      return `drop_shadow_${leaf}`;
    case "color":
    case "type":
      return leaf;
  }
}

/** Categories whose raw leaf name carries an inferable category prefix. */
function inferCategoryFromLeaf(leaf: string): TokenCategory | undefined {
  const segments = leaf.split("_");
  if (segments[0] === "spacing") return "space";
  if (segments[0] === "radius") return "radius";
  if (segments[0] === "opacity") return "opacity";
  if (segments[0] === "gradient") return "gradient";
  if (segments.includes("shadow")) return "shadow";
  return undefined;
}

// ---------------------------------------------------------------------------
// toCanonical / toRaw
// ---------------------------------------------------------------------------

/**
 * Raw name -> canonical ref.
 *
 * Accepts a dotted or slashed path (`color.light.core_sec_500`,
 * `color/light/core_sec_500`) or a bare leaf. The light/dark level is dropped —
 * it is a theme scope, not part of the ref. Breakpoints likewise become a media
 * query rather than a ref segment.
 *
 *   spacing.spacing_4                            -> space.4
 *   spacing.spacing_0_5                          -> space.0_5
 *   radius.radius_2xl                            -> radius.2xl
 *   radius.radius_rounded                        -> radius.rounded
 *   color.light.core_sec_500                     -> color.core_sec_500
 *   color.light.text_invert_high                 -> color.text_invert_high
 *   gradient.light.gradient_nue_vert_1_gradient  -> gradient.nue_vert_1
 *   shadow.light.drop_shadow_md                  -> shadow.md
 *   opacity.opacity_40                           -> opacity.40
 *   typography_desktop.dp_2_regular              -> type.dp_2_regular
 *
 * A bare leaf whose category cannot be inferred from its own name (every colour
 * and every type style) needs `category` passed explicitly, or resolution via a
 * theme's {@link NameMap}. Throws rather than guessing — a silently wrong ref is
 * worse than a loud failure in a codegen pipeline.
 */
export function toCanonical(raw: string, category?: TokenCategory): string {
  const path = raw.trim().replace(/\//g, ".");
  const segments = path.split(".").filter((s) => s.length > 0);
  if (segments.length === 0) throw new Error(`toCanonical: empty ref`);

  const leaf = segments[segments.length - 1]!;
  const head = segments.length > 1 ? segments[0]! : undefined;

  let cat: TokenCategory | undefined = category;
  if (!cat && head) cat = SECTION_TO_CATEGORY[head];
  // An already-canonical ref leads with a canonical category (`space.0_5`),
  // which is not a raw section name. Accepting it keeps the function idempotent.
  if (!cat && head && (TOKEN_CATEGORIES as readonly string[]).includes(head)) cat = head as TokenCategory;
  if (!cat) cat = inferCategoryFromLeaf(leaf);
  if (!cat) {
    throw new Error(
      `toCanonical: cannot infer category for "${raw}" — pass an explicit category or resolve it through the theme's name map`,
    );
  }

  // Already canonical (`color.core_sec_500`) — the head is a canonical category,
  // so the leaf has had its prefix stripped once already. Stripping again is a
  // no-op for every real name, but re-running it keeps the function idempotent.
  return `${cat}.${stripCategoryPrefix(leaf, cat)}`;
}

/**
 * Canonical ref -> raw leaf name, using each category's default raw pattern.
 *
 *   space.4          space    -> spacing_4
 *   radius.2xl       radius   -> radius_2xl
 *   color.core_x     color    -> core_x
 *   gradient.a_b     gradient -> gradient_a_b_gradient
 *   shadow.md        shadow   -> drop_shadow_md
 *
 * `category` may be omitted when `canonical` carries its own prefix.
 */
export function toRaw(canonical: string, category?: TokenCategory): string {
  const dot = canonical.indexOf(".");
  let cat = category;
  let leaf = canonical;
  if (dot > 0) {
    const head = canonical.slice(0, dot);
    if ((TOKEN_CATEGORIES as readonly string[]).includes(head)) {
      cat = cat ?? (head as TokenCategory);
      leaf = canonical.slice(dot + 1);
    }
  }
  if (!cat) throw new Error(`toRaw: cannot infer category for "${canonical}"`);
  return applyCategoryPrefix(leaf, cat);
}

// ---------------------------------------------------------------------------
// Deterministic ordering
// ---------------------------------------------------------------------------

type Chunk = string | number;

function chunk(name: string): Chunk[] {
  const out: Chunk[] = [];
  const re = /\d+|\D+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(name)) !== null) {
    const part = m[0];
    out.push(/^\d+$/.test(part) ? Number.parseInt(part, 10) : part);
  }
  return out;
}

/**
 * Natural, locale-independent ordering: digit runs compare numerically, everything
 * else by UTF-16 code unit. Deliberately NOT `localeCompare`, which varies by ICU
 * build and would break the byte-determinism guarantee on the emitted CSS.
 *
 * Sorts the space scale as 0, 0_5, 1, 1_5, 2 … 16 rather than 0, 1, 10, 11.
 */
export function compareTokenNames(a: string, b: string): number {
  if (a === b) return 0;
  const ca = chunk(a);
  const cb = chunk(b);
  const n = Math.max(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i];
    const y = cb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = typeof x === "number";
    const yNum = typeof y === "number";
    if (xNum && yNum) {
      if (x !== y) return x < y ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1; // numeric chunks sort before alphabetic ones
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Sort a map's keys deterministically and return the entries in that order. */
export function sortedEntries<V>(map: Map<string, V>): Array<[string, V]> {
  return [...map.entries()].sort((a, b) => compareTokenNames(a[0], b[0]));
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

/** `"3px"` -> 3, `3` -> 3, `"0"` -> 0. Returns undefined for anything unparseable. */
export function parseLength(value: string | number): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(px)?\s*$/.exec(value);
  if (!m) return undefined;
  return Number.parseFloat(m[1]!);
}

function normalizeShadow(raw: RawShadow): ShadowValue | undefined {
  const x = parseLength(raw.x);
  const y = parseLength(raw.y);
  const blur = parseLength(raw.blur);
  const spread = parseLength(raw.spread);
  const color = normalizeHex(raw.color);
  if (x === undefined || y === undefined || blur === undefined || spread === undefined) return undefined;
  if (!color) return undefined;
  return {
    x,
    y,
    blur,
    spread,
    color,
    opacity: raw.opacity,
    // Figma calls it "inner"; CSS calls it `inset`. "drop" emits nothing.
    inset: raw.type === "inner" || raw.type === "inset",
  };
}

function normalizeGradient(raw: RawGradient): GradientValue {
  return {
    kind: "linear",
    // Figma's `degree` and CSS's `<angle>` share an origin and direction: 180
    // means top-to-bottom in both. Verified against gradient_nue_vert_1, which
    // is transparent at 20% and opaque at 100% and renders top-transparent /
    // bottom-dark in Figma. Carried through verbatim — see README.
    degree: raw.degree,
    stops: raw.stops.map((s) => ({
      color: normalizeHex(s.color) ?? s.color,
      opacity: s.opacity,
      percent: s.percent,
    })),
  };
}

function normalizeType(raw: RawTypography): TypeValue {
  return {
    size: raw.size,
    weight: raw.weight,
    family: raw.typeface,
    lineHeight: raw.line_height,
    letterSpacing: raw.letter_spacing,
  };
}

// ---------------------------------------------------------------------------
// Name map
// ---------------------------------------------------------------------------

export function buildNameMap(entries: NameMapEntry[]): NameMap {
  const byRaw = new Map<string, Set<string>>();
  const byCanonical = new Map<string, Set<string>>();
  // Category-qualified indexes, which are unambiguous even when the bare leaf is not.
  const byRawQualified = new Map<string, string>();
  const byCanonicalQualified = new Map<string, string>();

  for (const e of entries) {
    (byRaw.get(e.raw) ?? byRaw.set(e.raw, new Set()).get(e.raw)!).add(e.canonical);
    (byCanonical.get(e.canonical) ?? byCanonical.set(e.canonical, new Set()).get(e.canonical)!).add(e.raw);
    byRawQualified.set(`${e.category} ${e.raw}`, e.canonical);
    byCanonicalQualified.set(`${e.category} ${e.canonical}`, e.raw);
  }

  const unique = new Map<string, NameMapEntry>();
  for (const e of entries) unique.set(`${e.category} ${e.canonical}`, e);

  return {
    toCanonical(raw, category) {
      if (category) return byRawQualified.get(`${category} ${raw}`);
      const set = byRaw.get(raw);
      if (!set || set.size !== 1) return undefined;
      return [...set][0];
    },
    toRaw(canonical, category) {
      const dot = canonical.indexOf(".");
      const head = dot > 0 ? canonical.slice(0, dot) : undefined;
      const cat =
        category ?? (head && (TOKEN_CATEGORIES as readonly string[]).includes(head) ? (head as TokenCategory) : undefined);
      if (cat) {
        const hit = byCanonicalQualified.get(`${cat} ${canonical}`);
        if (hit) return hit;
      }
      const set = byCanonical.get(canonical);
      if (!set || set.size !== 1) return undefined;
      return [...set][0];
    },
    entries() {
      return [...unique.values()].sort(
        (a, b) => compareTokenNames(a.category, b.category) || compareTokenNames(a.canonical, b.canonical),
      );
    },
    collisions() {
      const out: Array<{ key: string; direction: "raw" | "canonical"; refs: string[] }> = [];
      for (const [raw, set] of byRaw) {
        if (set.size > 1) out.push({ key: raw, direction: "raw", refs: [...set].sort(compareTokenNames) });
      }
      for (const [canonical, set] of byCanonical) {
        if (set.size > 1) {
          out.push({ key: canonical, direction: "canonical", refs: [...set].sort(compareTokenNames) });
        }
      }
      return out.sort((a, b) => compareTokenNames(a.key, b.key) || compareTokenNames(a.direction, b.direction));
    },
  };
}

// ---------------------------------------------------------------------------
// Theme normalization
// ---------------------------------------------------------------------------

export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A raw theme body, i.e. the value sitting under `tokens.<uuid>`. */
export interface RawThemeBody {
  theme_name?: string;
  badge?: Record<string, Record<string, unknown>>;
  button?: Record<string, Record<string, unknown>>;
  color?: Partial<Record<Scope, Record<string, string>>>;
  radius?: Record<string, number>;
  shadow?: Partial<Record<Scope, Record<string, RawShadow>>>;
  opacity?: Record<string, number>;
  spacing?: Record<string, number>;
  gradient?: Partial<Record<Scope, Record<string, RawGradient>>>;
  typography_mobile?: Record<string, RawTypography>;
  typography_tablet?: Record<string, RawTypography>;
  typography_desktop?: Record<string, RawTypography>;
}

/**
 * Turn one raw theme body into the normalized representation everything
 * downstream reads. Value-level problems (a malformed hex, an unparseable
 * shadow length) are NOT fixed here — they are left for `validate.ts` to report
 * and are simply skipped, so a broken input never silently becomes a plausible
 * output.
 */
export function normalizeTheme(id: string, raw: RawThemeBody): NormalizedTheme {
  const entries: NameMapEntry[] = [];
  const record = (raw_: string, canonical: string, category: TokenCategory, section: string) => {
    entries.push({ raw: raw_, canonical, category, section });
  };

  const space = new Map<string, number>();
  for (const [k, v] of Object.entries(raw.spacing ?? {})) {
    const leaf = stripCategoryPrefix(k, "space");
    space.set(leaf, v);
    record(k, `space.${leaf}`, "space", "spacing");
  }

  const radius = new Map<string, number>();
  for (const [k, v] of Object.entries(raw.radius ?? {})) {
    const leaf = stripCategoryPrefix(k, "radius");
    radius.set(leaf, v);
    record(k, `radius.${leaf}`, "radius", "radius");
  }

  const opacity = new Map<string, number>();
  for (const [k, v] of Object.entries(raw.opacity ?? {})) {
    const leaf = stripCategoryPrefix(k, "opacity");
    opacity.set(leaf, v);
    record(k, `opacity.${leaf}`, "opacity", "opacity");
  }

  const color: Record<Scope, Map<string, string>> = { light: new Map(), dark: new Map() };
  const gradient: Record<Scope, Map<string, GradientValue>> = { light: new Map(), dark: new Map() };
  const shadow: Record<Scope, Map<string, ShadowValue>> = { light: new Map(), dark: new Map() };

  for (const scope of SCOPES) {
    for (const [k, v] of Object.entries(raw.color?.[scope] ?? {})) {
      const leaf = stripCategoryPrefix(k, "color");
      color[scope].set(leaf, v);
      if (scope === "light") record(k, `color.${leaf}`, "color", "color");
    }
    for (const [k, v] of Object.entries(raw.gradient?.[scope] ?? {})) {
      const leaf = stripCategoryPrefix(k, "gradient");
      gradient[scope].set(leaf, normalizeGradient(v));
      if (scope === "light") record(k, `gradient.${leaf}`, "gradient", "gradient");
    }
    for (const [k, v] of Object.entries(raw.shadow?.[scope] ?? {})) {
      const leaf = stripCategoryPrefix(k, "shadow");
      const s = normalizeShadow(v);
      if (s) shadow[scope].set(leaf, s);
      if (scope === "light") record(k, `shadow.${leaf}`, "shadow", "shadow");
    }
  }

  const type: Record<Breakpoint, Map<string, TypeValue>> = {
    mobile: new Map(),
    tablet: new Map(),
    desktop: new Map(),
  };
  for (const bp of BREAKPOINTS) {
    const section = `typography_${bp}` as const;
    for (const [k, v] of Object.entries(raw[section] ?? {})) {
      const leaf = stripCategoryPrefix(k, "type");
      type[bp].set(leaf, normalizeType(v));
      record(k, `type.${leaf}`, "type", section);
    }
  }

  const name = raw.theme_name ?? id;
  return {
    id,
    name,
    slug: slugify(name),
    space,
    radius,
    opacity,
    color,
    gradient,
    shadow,
    type,
    emptyCategories: findEmptyCategories(raw),
    names: buildNameMap(entries),
  };
}

/**
 * Categories present in the file but carrying nothing. Feeds W4.
 * On the Southern Brave export this is exactly five:
 * badge.size, button.size, color.dark, gradient.dark, shadow.dark.
 */
export function findEmptyCategories(raw: RawThemeBody): string[] {
  const out: string[] = [];

  for (const section of ["badge", "button"] as const) {
    const body = raw[section];
    if (!body) continue;
    for (const sub of Object.keys(body).sort(compareTokenNames)) {
      if (Object.keys(body[sub] ?? {}).length === 0) out.push(`${section}.${sub}`);
    }
  }

  for (const section of ["color", "gradient", "shadow"] as const) {
    const body = raw[section];
    if (!body) continue;
    for (const scope of SCOPES) {
      if (!(scope in body)) continue;
      if (Object.keys(body[scope] ?? {}).length === 0) out.push(`${section}.${scope}`);
    }
  }

  for (const section of ["spacing", "radius", "opacity", ...BREAKPOINTS.map((b) => `typography_${b}`)] as const) {
    const body = (raw as Record<string, unknown>)[section] as Record<string, unknown> | undefined;
    if (body && Object.keys(body).length === 0) out.push(section);
  }

  return out.sort(compareTokenNames);
}

/** Style keys present on every breakpoint. The only set safe to emit a `TypeToken` for. */
export function typeIntersection(theme: NormalizedTheme): string[] {
  const sets = BREAKPOINTS.map((b) => theme.type[b]);
  const first = sets[0];
  if (!first) return [];
  return [...first.keys()].filter((k) => sets.every((s) => s.has(k))).sort(compareTokenNames);
}

/** Every style key on any breakpoint. */
export function typeUnion(theme: NormalizedTheme): string[] {
  const out = new Set<string>();
  for (const bp of BREAKPOINTS) for (const k of theme.type[bp].keys()) out.add(k);
  return [...out].sort(compareTokenNames);
}
