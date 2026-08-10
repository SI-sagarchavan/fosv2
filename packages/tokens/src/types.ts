/**
 * Core domain vocabulary.
 *
 * Everything downstream of this package speaks in canonical refs — `space.4`,
 * `color.core_sec_500`, `type.dp_2_regular`. The raw names from the design
 * system export are a separate vocabulary that only `normalize.ts` and the
 * Figma IR extractor ever touch.
 */

/** Canonical categories. The first segment of every canonical ref. */
export const CATEGORIES = [
  "space",
  "radius",
  "color",
  "opacity",
  "gradient",
  "shadow",
  "type",
  "surface",
  "asset",
  "duration",
  "easing",
  "motion",
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * Categories that come out of the raw theme file.
 * `surface`/`asset` are authored in the surfaces file; `duration`/`easing`/
 * `motion` are package-level built-ins (same idea as breakpoints).
 */
export const TOKEN_CATEGORIES = [
  "space",
  "radius",
  "color",
  "opacity",
  "gradient",
  "shadow",
  "type",
] as const;

export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];

/** Ordered small-to-large. Order is load-bearing: mobile-first CSS depends on it. */
export const BREAKPOINTS = ["mobile", "tablet", "desktop"] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

/** Theme scopes present in the raw file. `dark` is currently empty everywhere. */
export const SCOPES = ["light", "dark"] as const;
export type Scope = (typeof SCOPES)[number];

// ---------------------------------------------------------------------------
// Category-scoped ref types
// ---------------------------------------------------------------------------

/**
 * Structural ref types, one per category.
 *
 * These are theme-INDEPENDENT and carry only the category, which is what lets a
 * consumer say "this prop takes a type token, never a colour" without pinning
 * itself to one tenant's palette. `emitTypes()` produces the exact per-theme
 * literal unions under the same names; import one or the other, not both.
 */
export type TokenRef = `${string}.${string}`;
export type SpaceToken = `space.${string}`;
export type RadiusToken = `radius.${string}`;
export type ColorToken = `color.${string}`;
export type OpacityToken = `opacity.${string}`;
export type GradientToken = `gradient.${string}`;
export type ShadowToken = `shadow.${string}`;
export type TypeToken = `type.${string}`;
export type SurfaceToken = `surface.${string}`;
export type AssetToken = `asset.${string}`;
export type DurationToken = `duration.${string}`;
export type EasingToken = `easing.${string}`;
export type MotionToken = `motion.${string}`;

// ---------------------------------------------------------------------------
// Raw shapes (what the export actually contains)
// ---------------------------------------------------------------------------

export interface RawShadow {
  x: string | number;
  y: string | number;
  blur: string | number;
  spread: string | number;
  color: string;
  opacity: number;
  type: string;
}

export interface RawGradientStop {
  color: string;
  opacity: number;
  percent: number;
}

export interface RawGradient {
  type: string;
  degree: number;
  stops: RawGradientStop[];
}

export interface RawTypography {
  name?: string;
  size: number;
  weight: number;
  typeface: string;
  line_height: number;
  letter_spacing: number;
}

// ---------------------------------------------------------------------------
// Normalized values
// ---------------------------------------------------------------------------

/** A shadow with numeric lengths in px and a resolved rgb colour. */
export interface ShadowValue {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
  /** 0-100, as authored. */
  opacity: number;
  /** `inner` renders the CSS `inset` keyword; `drop` renders nothing. */
  inset: boolean;
}

export interface GradientStop {
  color: string;
  /** 0-100. */
  opacity: number;
  /** 0-100. */
  percent: number;
}

export interface GradientValue {
  kind: "linear";
  degree: number;
  stops: GradientStop[];
}

export interface TypeValue {
  size: number;
  weight: number;
  family: string;
  lineHeight: number;
  letterSpacing: number;
}

/** Discriminated union returned by `registry.resolve()`. */
export type TokenValue =
  | { category: "space"; px: number }
  | { category: "radius"; px: number }
  | { category: "color"; hex: string; rgb: [number, number, number] }
  | { category: "opacity"; percent: number; unit: number }
  | { category: "gradient"; gradient: GradientValue }
  | { category: "shadow"; shadow: ShadowValue }
  | { category: "type"; byBreakpoint: Partial<Record<Breakpoint, TypeValue>> }
  | { category: "duration"; ms: number }
  | { category: "easing"; curve: string }
  | { category: "motion"; policy: "respect" | "ignore" };

// ---------------------------------------------------------------------------
// The normalized theme — the single in-memory representation everything reads
// ---------------------------------------------------------------------------

export interface NormalizedTheme {
  /** The UUID the raw file is keyed by. */
  id: string;
  /** e.g. "Style Southern Brave". */
  name: string;
  /** Kebab slug derived from `name`, used for `[data-fos-theme="…"]`. */
  slug: string;

  /** Canonical leaf -> px. Keyed WITHOUT the `space.` prefix. */
  space: Map<string, number>;
  radius: Map<string, number>;
  /** 0-100 as authored. */
  opacity: Map<string, number>;
  /** Per scope, because `dark` is a separate palette rather than a separate ref. */
  color: Record<Scope, Map<string, string>>;
  gradient: Record<Scope, Map<string, GradientValue>>;
  shadow: Record<Scope, Map<string, ShadowValue>>;
  /** Per breakpoint. Key sets are NOT guaranteed equal — that is exactly what E1 lints. */
  type: Record<Breakpoint, Map<string, TypeValue>>;

  /** Categories that were present but empty, e.g. `badge.size`. Feeds W4. */
  emptyCategories: string[];

  /** Bidirectional canonical <-> raw name map, built from the real data. */
  names: NameMap;
}

export interface NameMapEntry {
  canonical: string;
  raw: string;
  category: TokenCategory;
  /** The raw section the token was read from, e.g. `typography_desktop`. */
  section: string;
}

export interface NameMap {
  /** Raw leaf name -> canonical ref. Ambiguous leaves (same name in two categories) are absent. */
  toCanonical(raw: string, category?: TokenCategory): string | undefined;
  /** Canonical ref -> the exact raw leaf name as authored. */
  toRaw(canonical: string, category?: TokenCategory): string | undefined;
  entries(): NameMapEntry[];
  /** Raw leaves that resolve to more than one canonical ref, or vice versa. */
  collisions(): Array<{ key: string; direction: "raw" | "canonical"; refs: string[] }>;
}
