/**
 * Part 4 — CSS emission.
 *
 * Byte-deterministic by construction: every map is walked through
 * `compareTokenNames`, nothing reads the clock, and no value is formatted with
 * a locale-sensitive API. The output is content-hashed for cache busting, so a
 * rebuild that changes a byte for no reason costs every user a cache miss.
 */

import type { Breakpoint, GradientValue, NormalizedTheme, Scope, ShadowValue, TypeValue } from "../types.js";
import { BREAKPOINTS } from "../types.js";
import { compareTokenNames, sortedEntries, typeIntersection, typeUnion } from "../normalize.js";
import { formatNumber, formatPercent, hexToRgb, opacityToUnit, rgbaFn } from "../color.js";
import { coalesceStops } from "../gradient.js";
import { cssClassName, cssRgbVarName, cssVar, cssVarName, parseRef, VAR_PREFIX } from "../refs.js";
import { breakpointMinWidth, DEFAULT_CONFIG, type TokensConfig } from "../config.js";
import type { Surface, SurfaceBorder, SurfaceLayer, SurfaceSet } from "../raw-schema.js";
import {
  DEFAULT_REDUCED_MOTION_POLICY,
  DURATION_SCALE,
  EASING_SCALE,
} from "../motion.js";
import { resolveAsset, type AssetContext } from "../assets.js";

export interface EmitCssOptions extends Partial<TokensConfig> {
  surfaces?: SurfaceSet;
  /**
   * When set, surface image layers resolve `asset.*` refs through
   * {@link resolveAsset} instead of the opaque URL map in the surfaces file.
   */
  assets?: AssetContext;
}

export interface EmitCssResult {
  css: string;
  /** Non-fatal notes raised during emission (partial typography fallbacks, dropped data). */
  warnings: string[];
}

const INDENT = "  ";

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

export function formatPx(n: number): string {
  return `${formatNumber(n)}px`;
}

/**
 * Figma's `degree` is passed through verbatim.
 *
 * Both systems measure from the same origin in the same direction: 180 means
 * top-to-bottom. Verified against `gradient_nue_vert_1`, which is authored
 * transparent at 20% and opaque at 100% at degree 180, and renders
 * top-transparent / bottom-dark in Figma — exactly what CSS
 * `linear-gradient(180deg, …)` produces. No conversion is applied; if a future
 * export disagrees, this is the one line to change.
 */
export function formatGradient(gradient: GradientValue, alphaScale = 1): string {
  const stops = coalesceStops(gradient.stops).map(
    (s) => `${rgbaFn(s.color, s.opacity * alphaScale)} ${formatPercent(s.percent)}%`,
  );
  return `linear-gradient(${formatNumber(gradient.degree)}deg, ${stops.join(", ")})`;
}

/** `3px 3px 4px 0px rgb(26 26 26 / 100%)`, prefixed with `inset` for inner shadows. */
export function formatShadow(shadow: ShadowValue): string {
  const parts = [
    formatPx(shadow.x),
    formatPx(shadow.y),
    formatPx(shadow.blur),
    formatPx(shadow.spread),
    rgbaFn(shadow.color, shadow.opacity),
  ];
  // Figma calls it "inner"; CSS spells it `inset`. "drop" emits nothing at all.
  return shadow.inset ? `inset ${parts.join(" ")}` : parts.join(" ");
}

function fontFamily(family: string): string {
  return /^[A-Za-z][A-Za-z0-9-]*$/.test(family) ? family : `"${family}"`;
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

const TYPE_FIELDS = ["size", "weight", "family", "leading", "tracking"] as const;
type TypeField = (typeof TYPE_FIELDS)[number];

function typeFieldValue(style: TypeValue, field: TypeField): string {
  switch (field) {
    case "size":
      return formatPx(style.size);
    case "weight":
      return formatNumber(style.weight);
    case "family":
      return fontFamily(style.family);
    case "leading":
      return formatPx(style.lineHeight);
    case "tracking":
      // The export carries a unitless number and every value is 0. `em` keeps
      // tracking proportional to size, which is what a design system wants once
      // a non-zero value finally appears.
      return `${formatNumber(style.letterSpacing)}em`;
  }
}

function typeVarName(leaf: string, field: TypeField): string {
  return `${cssVarName(`type.${leaf}`)}-${field}`;
}

interface ResolvedTypeStyle {
  /** The style actually used at each breakpoint after any fallback. */
  byBreakpoint: Record<Breakpoint, TypeValue>;
}

/**
 * Pick the style for each breakpoint, falling back when `allowPartialTypography`
 * is on. Prefers the nearest SMALLER breakpoint (mobile-first inheritance is
 * what the cascade already does), and only reaches upward when nothing smaller
 * exists — a desktop-only style has to come from somewhere.
 */
function resolveTypeStyle(
  theme: NormalizedTheme,
  leaf: string,
  warnings: string[],
): ResolvedTypeStyle | undefined {
  const direct: Partial<Record<Breakpoint, TypeValue>> = {};
  for (const bp of BREAKPOINTS) {
    const hit = theme.type[bp].get(leaf);
    if (hit) direct[bp] = hit;
  }
  if (Object.keys(direct).length === 0) return undefined;

  const out: Partial<Record<Breakpoint, TypeValue>> = {};
  for (const [i, bp] of BREAKPOINTS.entries()) {
    const own = direct[bp];
    if (own) {
      out[bp] = own;
      continue;
    }
    let source: Breakpoint | undefined;
    for (let j = i - 1; j >= 0; j--) {
      const candidate = BREAKPOINTS[j]!;
      if (direct[candidate]) {
        source = candidate;
        break;
      }
    }
    if (!source) {
      for (let j = i + 1; j < BREAKPOINTS.length; j++) {
        const candidate = BREAKPOINTS[j]!;
        if (direct[candidate]) {
          source = candidate;
          break;
        }
      }
    }
    if (!source) return undefined;
    out[bp] = direct[source]!;
    warnings.push(
      `type.${leaf} is not defined for ${bp}; falling back to ${source} (--allow-partial-typography)`,
    );
  }
  return { byBreakpoint: out as Record<Breakpoint, TypeValue> };
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/** A colour ref rendered at an alpha, via the mandatory `-rgb` companion var. */
function colorAt(ref: string, opacity: number | undefined): string {
  if (opacity === undefined || opacity === 100) return cssVar(ref);
  return `rgb(var(${cssRgbVarName(ref)}) / ${formatPercent(opacity)}%)`;
}

function layerImage(
  theme: NormalizedTheme,
  layer: SurfaceLayer,
  surfaces: SurfaceSet,
  warnings: string[],
  assets?: AssetContext,
): string {
  switch (layer.type) {
    case "color": {
      // A flat colour has to become a gradient to sit in `background-image`.
      const c = colorAt(layer.ref, layer.opacity);
      return `linear-gradient(${c} 0%, ${c} 100%)`;
    }
    case "gradient": {
      if (layer.opacity === undefined || layer.opacity === 100) return cssVar(layer.ref);
      // Alpha has to be folded into the stops, so the var is inlined here.
      const parsed = parseRef(layer.ref);
      const gradient = parsed ? (theme.gradient.light.get(parsed.leaf) ?? undefined) : undefined;
      if (!gradient) return cssVar(layer.ref);
      return formatGradient(gradient, layer.opacity / 100);
    }
    case "image": {
      const parsed = parseRef(layer.ref);
      let url: string | undefined;
      if (parsed && assets) {
        try {
          url = resolveAsset(layer.ref, assets);
        } catch {
          url = undefined;
        }
      }
      if (!url && parsed) url = surfaces.assets.get(parsed.leaf);
      if (!url) return "none";
      if (layer.opacity !== undefined && layer.opacity !== 100) {
        // CSS has no per-background-layer opacity, so this cannot be emitted as
        // part of the layer list. See README "Image layer opacity".
        warnings.push(
          `surface layer ${layer.ref} carries opacity ${layer.opacity} — CSS cannot apply opacity to a background-image layer; emitted as a --*-opacity custom property instead`,
        );
      }
      return `url("${url}")`;
    }
  }
}

function layerSize(layer: SurfaceLayer): string {
  if (layer.type !== "image") return "auto";
  switch (layer.fit) {
    case "cover":
      return "cover";
    case "contain":
      return "contain";
    default:
      return "auto";
  }
}

function layerRepeat(layer: SurfaceLayer): string {
  if (layer.type !== "image") return "no-repeat";
  return layer.fit === "repeat" ? "repeat" : "no-repeat";
}

function borderShorthand(border: SurfaceBorder): string {
  return `${formatPx(border.width)} ${border.style ?? "solid"} ${colorAt(border.color, border.opacity)}`;
}

function emitSurface(
  theme: NormalizedTheme,
  name: string,
  surface: Surface,
  surfaces: SurfaceSet,
  warnings: string[],
  assets?: AssetContext,
): string[] {
  const lines: string[] = [];
  const selector = `.${cssClassName("surface", name)}`;
  const borders = surface.borders ?? [];
  const insetBorder = borders.find((b) => b.inset !== undefined);
  const flatBorders = borders.filter((b) => b.inset === undefined);

  const body: string[] = [];
  // `position: relative` is only emitted when something actually needs a
  // containing block — the inset border's ::before.
  if (insetBorder) body.push("position: relative;");
  if (surface.radius) body.push(`border-radius: ${cssVar(surface.radius)};`);

  // Layers are authored BOTTOM to TOP. `background-image` paints the FIRST
  // listed layer on TOP, so the array is reversed here. Get this backwards and
  // every textured surface renders inside-out.
  const layers = [...(surface.layers ?? [])].reverse();
  if (layers.length > 0) {
    body.push(
      `background-image: ${layers.map((l) => layerImage(theme, l, surfaces, warnings, assets)).join(", ")};`,
    );

    const blends = layers.map((l) => l.blend ?? "normal");
    if (blends.some((b) => b !== "normal")) body.push(`background-blend-mode: ${blends.join(", ")};`);

    const sizes = layers.map(layerSize);
    if (sizes.some((s) => s !== "auto")) {
      body.push(`background-size: ${sizes.join(", ")};`);
      body.push(`background-position: ${layers.map(() => "center").join(", ")};`);
    }
    const repeats = layers.map(layerRepeat);
    if (repeats.some((r) => r !== "no-repeat") || sizes.some((s) => s !== "auto")) {
      body.push(`background-repeat: ${repeats.join(", ")};`);
    }

    // Image-layer opacity is not expressible in the layer list; surface it as a
    // custom property so a renderer can honour it deliberately.
    for (const [i, layer] of layers.entries()) {
      if (layer.type === "image" && layer.opacity !== undefined && layer.opacity !== 100) {
        body.push(`${VAR_PREFIX}surface-${name}-layer-${i}-opacity: ${formatNumber(opacityToUnit(layer.opacity))};`);
      }
    }
  }

  const first = flatBorders[0];
  if (first) body.push(`border: ${borderShorthand(first)};`);

  // A second flat border has nowhere to go as `border`, so it becomes an inset
  // ring — exact, and it composes with the shadow in the same declaration.
  const rings = flatBorders.slice(1).map((b) => `inset 0 0 0 ${formatPx(b.width)} ${colorAt(b.color, b.opacity)}`);
  const shadows = [...(surface.shadow ? [cssVar(surface.shadow)] : []), ...rings];
  if (shadows.length > 0) body.push(`box-shadow: ${shadows.join(", ")};`);

  lines.push(`${selector} {`, ...body.map((l) => INDENT + l), "}");

  if (insetBorder) {
    const beforeBody = [
      `content: "";`,
      "position: absolute;",
      `inset: ${formatPx(insetBorder.inset ?? 0)};`,
      "pointer-events: none;",
      `border: ${borderShorthand(insetBorder)};`,
      ...(insetBorder.radius ? [`border-radius: ${cssVar(insetBorder.radius)};`] : []),
    ];
    lines.push("", `${selector}::before {`, ...beforeBody.map((l) => INDENT + l), "}");
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

export function emitCss(theme: NormalizedTheme, options: EmitCssOptions = {}): EmitCssResult {
  const config: TokensConfig = {
    breakpoints: { ...DEFAULT_CONFIG.breakpoints, ...(options.breakpoints ?? {}) },
    scope: options.scope ?? DEFAULT_CONFIG.scope,
    allowPartialTypography: options.allowPartialTypography ?? DEFAULT_CONFIG.allowPartialTypography,
  };
  const warnings: string[] = [];
  const selector = config.scope === "attr" ? `[data-fos-theme="${theme.slug}"]` : ":root";

  const out: string[] = [];
  out.push(`/* @fanos/tokens — ${theme.name} (${theme.id}) */`);
  out.push("/* Generated file. Do not edit. Regenerate with `fos-tokens build`. */");
  out.push("");

  // --- scales -------------------------------------------------------------
  const scale: string[] = [];

  scale.push("/* breakpoints (config, not from the token file) */");
  scale.push(`${VAR_PREFIX}bp-md: ${formatPx(config.breakpoints.md)};`);
  scale.push(`${VAR_PREFIX}bp-lg: ${formatPx(config.breakpoints.lg)};`);

  scale.push("", "/* space */");
  for (const [leaf, px] of sortedEntries(theme.space)) {
    scale.push(`${cssVarName(`space.${leaf}`)}: ${formatPx(px)};`);
  }

  scale.push("", "/* radius */");
  for (const [leaf, px] of sortedEntries(theme.radius)) {
    scale.push(`${cssVarName(`radius.${leaf}`)}: ${formatPx(px)};`);
  }

  scale.push("", "/* opacity */");
  for (const [leaf, percent] of sortedEntries(theme.opacity)) {
    scale.push(`${cssVarName(`opacity.${leaf}`)}: ${formatNumber(opacityToUnit(percent))};`);
  }

  scale.push("", "/* color — every colour emits a hex and an `r g b` triplet */");
  scale.push(...colorVars(theme, "light"));

  scale.push("", "/* gradient */");
  for (const [leaf, gradient] of sortedEntries(theme.gradient.light)) {
    scale.push(`${cssVarName(`gradient.${leaf}`)}: ${formatGradient(gradient)};`);
  }

  scale.push("", "/* shadow */");
  for (const [leaf, shadow] of sortedEntries(theme.shadow.light)) {
    scale.push(`${cssVarName(`shadow.${leaf}`)}: ${formatShadow(shadow)};`);
  }

  // Built-in motion scale — not in the theme export.
  scale.push("", "/* duration */");
  for (const [leaf, ms] of Object.entries(DURATION_SCALE)) {
    scale.push(`${cssVarName(`duration.${leaf}`)}: ${formatNumber(ms)}ms;`);
  }
  scale.push("", "/* easing */");
  for (const [leaf, curve] of Object.entries(EASING_SCALE)) {
    scale.push(`${cssVarName(`easing.${leaf}`)}: ${curve};`);
  }
  scale.push("", "/* motion policy */");
  scale.push(`${cssVarName("motion.reducedPolicy")}: ${DEFAULT_REDUCED_MOTION_POLICY};`);

  // --- typography ---------------------------------------------------------
  const keys = config.allowPartialTypography ? typeUnion(theme) : typeIntersection(theme);
  const resolved = new Map<string, ResolvedTypeStyle>();
  for (const leaf of keys) {
    const style = resolveTypeStyle(theme, leaf, warnings);
    if (style) resolved.set(leaf, style);
  }

  scale.push("", "/* type — mobile-first; larger breakpoints override below */");
  for (const leaf of keys) {
    const style = resolved.get(leaf);
    if (!style) continue;
    for (const field of TYPE_FIELDS) {
      scale.push(`${typeVarName(leaf, field)}: ${typeFieldValue(style.byBreakpoint.mobile, field)};`);
    }
  }

  out.push(`${selector} {`, ...scale.map((l) => (l === "" ? "" : INDENT + l)), "}");

  // Only the vars that actually CHANGE at a breakpoint are re-declared. The
  // cascade carries the rest, which keeps the emitted file a third of the size
  // and makes a diff between two breakpoints readable.
  for (const bp of ["tablet", "desktop"] as const) {
    const prev = bp === "tablet" ? "mobile" : "tablet";
    const block: string[] = [];
    for (const leaf of keys) {
      const style = resolved.get(leaf);
      if (!style) continue;
      for (const field of TYPE_FIELDS) {
        const now = typeFieldValue(style.byBreakpoint[bp], field);
        if (now === typeFieldValue(style.byBreakpoint[prev], field)) continue;
        block.push(`${typeVarName(leaf, field)}: ${now};`);
      }
    }
    if (block.length === 0) continue;
    out.push("");
    out.push(`@media (min-width: ${formatPx(breakpointMinWidth(bp, config.breakpoints))}) {`);
    out.push(`${INDENT}${selector} {`);
    out.push(...block.map((l) => INDENT + INDENT + l));
    out.push(`${INDENT}}`);
    out.push("}");
  }

  // --- dark scope ---------------------------------------------------------
  const darkVars = [
    ...colorVars(theme, "dark"),
    ...sortedEntries(theme.gradient.dark).map(([l, g]) => `${cssVarName(`gradient.${l}`)}: ${formatGradient(g)};`),
    ...sortedEntries(theme.shadow.dark).map(([l, s]) => `${cssVarName(`shadow.${l}`)}: ${formatShadow(s)};`),
  ];
  if (darkVars.length > 0) {
    out.push("", `[data-fos-scheme="dark"] {`, ...darkVars.map((l) => INDENT + l), "}");
  }

  // --- type utilities -----------------------------------------------------
  if (keys.length > 0) {
    out.push("", "/* type utilities — responsive via the vars above, so declared once */");
    for (const leaf of keys) {
      if (!resolved.has(leaf)) continue;
      out.push(`.${cssClassName("type", leaf)} {`);
      out.push(`${INDENT}font-family: var(${typeVarName(leaf, "family")});`);
      out.push(`${INDENT}font-size: var(${typeVarName(leaf, "size")});`);
      out.push(`${INDENT}font-weight: var(${typeVarName(leaf, "weight")});`);
      out.push(`${INDENT}line-height: var(${typeVarName(leaf, "leading")});`);
      out.push(`${INDENT}letter-spacing: var(${typeVarName(leaf, "tracking")});`);
      out.push("}");
    }
  }

  // --- surfaces -----------------------------------------------------------
  if (options.surfaces && options.surfaces.surfaces.size > 0) {
    out.push("", "/* surfaces */");
    const names = [...options.surfaces.surfaces.keys()].sort(compareTokenNames);
    for (const [i, name] of names.entries()) {
      if (i > 0) out.push("");
      out.push(
        ...emitSurface(
          theme,
          name,
          options.surfaces.surfaces.get(name)!,
          options.surfaces,
          warnings,
          options.assets,
        ),
      );
    }
  }

  return { css: `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`, warnings };
}

function colorVars(theme: NormalizedTheme, scope: Scope): string[] {
  const out: string[] = [];
  for (const [leaf, hex] of sortedEntries(theme.color[scope])) {
    const ref = `color.${leaf}`;
    const rgb = hexToRgb(hex);
    out.push(`${cssVarName(ref)}: ${hex};`);
    // MANDATORY companion. The token file has no alpha variants, so every
    // surface that composites (`rgb(var(--x-rgb) / 20%)`) depends on this
    // existing for every single colour.
    if (rgb) out.push(`${cssRgbVarName(ref)}: ${rgb.join(" ")};`);
  }
  return out;
}
