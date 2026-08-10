/**
 * @fanos/tokens — the canonical source of truth for design tokens.
 *
 * Pipeline: raw export -> normalize -> validate -> emit (CSS, TypeScript,
 * Tailwind) + a runtime registry.
 *
 * Nothing downstream may hand-maintain a token. If a consumer needs something,
 * it is added here and regenerated.
 */

export type {
  AssetToken,
  Breakpoint,
  Category,
  ColorToken,
  DurationToken,
  EasingToken,
  GradientStop,
  GradientToken,
  GradientValue,
  MotionToken,
  OpacityToken,
  RadiusToken,
  ShadowToken,
  SpaceToken,
  SurfaceToken,
  TokenRef,
  TypeToken,
  NameMap,
  NameMapEntry,
  NormalizedTheme,
  RawGradient,
  RawGradientStop,
  RawShadow,
  RawTypography,
  Scope,
  ShadowValue,
  TokenCategory,
  TokenValue,
  TypeValue,
} from "./types.js";
export { BREAKPOINTS, CATEGORIES, SCOPES, TOKEN_CATEGORIES } from "./types.js";

// Part 1 — normalization (pure)
export {
  applyCategoryPrefix,
  buildNameMap,
  compareTokenNames,
  findEmptyCategories,
  normalizeTheme,
  parseLength,
  SECTION_TO_CATEGORY,
  sectionBreakpoint,
  slugify,
  sortedEntries,
  stripCategoryPrefix,
  toCanonical,
  toRaw,
  typeIntersection,
  typeUnion,
} from "./normalize.js";
export type { RawThemeBody } from "./normalize.js";

// Refs, colours, gradients
export {
  CLASS_PREFIX,
  cssClassName,
  cssRgbVarName,
  cssVar,
  cssVarName,
  dashify,
  parseRef,
  refExists,
  resolveRef,
  VAR_PREFIX,
} from "./refs.js";
export type { ParsedRef } from "./refs.js";
export { formatNumber, hexToRgb, isValidHex, normalizeHex, opacityToUnit, rgbaFn, rgbTriplet } from "./color.js";
export type { Rgb } from "./color.js";
export { coalesceStops, decreasingStopIndexes, stopRuns } from "./gradient.js";
export type { StopRun } from "./gradient.js";

// Part 2 — surfaces
export {
  parseSurfaceFile,
  rawThemeFileSchema,
  surfaceFileSchema,
  surfaceSchema,
} from "./raw-schema.js";
export type { Surface, SurfaceBorder, SurfaceLayer, SurfaceSet } from "./raw-schema.js";

// Part 3 — validation (pure)
export { errorClasses, findingsByCode, FINDING_CODES, validateTheme } from "./validate.js";
export type { Finding, FindingCode, Severity, ValidateOptions, ValidationResult } from "./validate.js";
export { formatReport, jsonReport } from "./report.js";
export type { JsonReport } from "./report.js";

// Parts 4/5/7 — emission
export { emitCss, formatGradient, formatPx, formatShadow } from "./emit/css.js";
export type { EmitCssOptions, EmitCssResult } from "./emit/css.js";
export { emitTypes, tokenUnions } from "./emit/types.js";
export type { EmitTypesOptions } from "./emit/types.js";
export { detectTailwindMajor, emitTailwindV3, emitTailwindV4 } from "./emit/tailwind.js";
export type { EmitTailwindOptions } from "./emit/tailwind.js";

// Part 6 — registry
export { createRegistry, search, SEARCH_LIMIT } from "./registry.js";
export type { Registry, RegistryOptions, TokenDescription } from "./registry.js";

// Config + loading
export { breakpointMinWidth, DEFAULT_BREAKPOINTS, DEFAULT_CONFIG, resolveConfig } from "./config.js";
export type { Breakpoints, TokensConfig } from "./config.js";
export { loadSurfaces, loadTheme, parseThemeJson } from "./load.js";

// Motion scale (built-in) + asset resolution
export {
  DEFAULT_REDUCED_MOTION_POLICY,
  DURATION_LEAVES,
  DURATION_SCALE,
  durationMs,
  EASING_LEAVES,
  EASING_SCALE,
  easingCurve,
} from "./motion.js";
export type { DurationLeaf, EasingLeaf, ReducedMotionPolicy } from "./motion.js";
export { LOCAL_ASSET_CONTEXT, resolveAsset } from "./assets.js";
export type { AssetContext } from "./assets.js";
