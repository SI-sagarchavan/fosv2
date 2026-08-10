/**
 * Canonical ref parsing, resolution and CSS naming. Pure.
 *
 * One module owns the ref -> CSS custom property mapping so the emitter, the
 * registry and the validator can never disagree about what `space.0_5` is
 * called.
 */

import type { Category, NormalizedTheme, Scope, TokenValue } from "./types.js";
import { CATEGORIES } from "./types.js";
import { hexToRgb, opacityToUnit } from "./color.js";
import type { SurfaceSet } from "./raw-schema.js";
import {
  DEFAULT_REDUCED_MOTION_POLICY,
  durationMs,
  easingCurve,
} from "./motion.js";

export const VAR_PREFIX = "--fos-";
export const CLASS_PREFIX = "fos-";

export interface ParsedRef {
  category: Category;
  /** Everything after the first dot. `asset.texture.stripes` -> `texture.stripes`. */
  leaf: string;
}

export function parseRef(ref: string): ParsedRef | undefined {
  const dot = ref.indexOf(".");
  if (dot <= 0) return undefined;
  const head = ref.slice(0, dot);
  const leaf = ref.slice(dot + 1);
  if (!leaf) return undefined;
  if (!(CATEGORIES as readonly string[]).includes(head)) return undefined;
  return { category: head as Category, leaf };
}

/**
 * Underscore -> dash, EXCEPT between two digits.
 *
 * That single exception is what keeps the half-step spacing keys legible:
 * `space.0_5` becomes `--fos-space-0_5`, not `--fos-space-0-5`, which would be
 * indistinguishable from a hypothetical `space.0.5` or `space.0-5`. Every other
 * underscore in the vocabulary sits next to at least one letter and dashes
 * normally (`core_sec_500` -> `core-sec-500`).
 */
export function dashify(name: string): string {
  return name.replace(/_/g, (_m, offset: number, whole: string) => {
    const prev = whole[offset - 1];
    const next = whole[offset + 1];
    return prev !== undefined && next !== undefined && prev >= "0" && prev <= "9" && next >= "0" && next <= "9"
      ? "_"
      : "-";
  });
}

/** `space.0_5` -> `--fos-space-0_5`; `color.core_sec_500` -> `--fos-color-core-sec-500`. */
export function cssVarName(ref: string): string {
  return VAR_PREFIX + dashify(ref.replace(/\./g, "-"));
}

/** The `-rgb` companion every colour is required to emit. */
export function cssRgbVarName(ref: string): string {
  return `${cssVarName(ref)}-rgb`;
}

export function cssVar(ref: string): string {
  return `var(${cssVarName(ref)})`;
}

/**
 * Class names keep the leaf VERBATIM — `.fos-type-dp_2_regular`,
 * `.fos-surface-card_player`. Authors type these by hand and match them against
 * the surface/type keys they wrote; silently dashing them would break that.
 */
export function cssClassName(kind: "type" | "surface", leaf: string): string {
  return `${CLASS_PREFIX}${kind}-${leaf}`;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Does this ref point at something real?
 *
 * `surfaces` is optional; without it, `surface.*` and `asset.*` refs cannot be
 * checked and are reported as unresolvable.
 */
export function refExists(theme: NormalizedTheme, ref: string, surfaces?: SurfaceSet, scope: Scope = "light"): boolean {
  const parsed = parseRef(ref);
  if (!parsed) return false;
  const { category, leaf } = parsed;
  switch (category) {
    case "space":
      return theme.space.has(leaf);
    case "radius":
      return theme.radius.has(leaf);
    case "opacity":
      return theme.opacity.has(leaf);
    case "color":
      return theme.color[scope].has(leaf) || theme.color.light.has(leaf);
    case "gradient":
      return theme.gradient[scope].has(leaf) || theme.gradient.light.has(leaf);
    case "shadow":
      return theme.shadow[scope].has(leaf) || theme.shadow.light.has(leaf);
    case "type":
      // A type ref is only real if it exists on every breakpoint; a partial one
      // resolves at some viewports and 404s at others, which is E1's whole point.
      return theme.type.mobile.has(leaf) && theme.type.tablet.has(leaf) && theme.type.desktop.has(leaf);
    case "surface":
      return surfaces?.surfaces.has(leaf) ?? false;
    case "asset":
      // Assets resolve structurally via resolveAsset; the surfaces map is an
      // optional override/allow-list when present. Without a surfaces file we
      // still accept well-formed asset refs so the renderer can resolve them.
      if (surfaces) return surfaces.assets.has(leaf);
      return leaf.includes(".");
    case "duration":
      return durationMs(leaf) !== undefined;
    case "easing":
      return easingCurve(leaf) !== undefined;
    case "motion":
      return leaf === "reducedPolicy";
  }
}

export function resolveRef(theme: NormalizedTheme, ref: string, scope: Scope = "light"): TokenValue | undefined {
  const parsed = parseRef(ref);
  if (!parsed) return undefined;
  const { category, leaf } = parsed;
  switch (category) {
    case "space": {
      const px = theme.space.get(leaf);
      return px === undefined ? undefined : { category: "space", px };
    }
    case "radius": {
      const px = theme.radius.get(leaf);
      return px === undefined ? undefined : { category: "radius", px };
    }
    case "opacity": {
      const percent = theme.opacity.get(leaf);
      return percent === undefined ? undefined : { category: "opacity", percent, unit: opacityToUnit(percent) };
    }
    case "color": {
      const hex = theme.color[scope].get(leaf) ?? theme.color.light.get(leaf);
      if (hex === undefined) return undefined;
      const rgb = hexToRgb(hex);
      return rgb ? { category: "color", hex, rgb } : undefined;
    }
    case "gradient": {
      const gradient = theme.gradient[scope].get(leaf) ?? theme.gradient.light.get(leaf);
      return gradient === undefined ? undefined : { category: "gradient", gradient };
    }
    case "shadow": {
      const shadow = theme.shadow[scope].get(leaf) ?? theme.shadow.light.get(leaf);
      return shadow === undefined ? undefined : { category: "shadow", shadow };
    }
    case "type": {
      const byBreakpoint = {
        mobile: theme.type.mobile.get(leaf),
        tablet: theme.type.tablet.get(leaf),
        desktop: theme.type.desktop.get(leaf),
      };
      if (!byBreakpoint.mobile && !byBreakpoint.tablet && !byBreakpoint.desktop) return undefined;
      return { category: "type", byBreakpoint };
    }
    case "duration": {
      const ms = durationMs(leaf);
      return ms === undefined ? undefined : { category: "duration", ms };
    }
    case "easing": {
      const curve = easingCurve(leaf);
      return curve === undefined ? undefined : { category: "easing", curve };
    }
    case "motion": {
      if (leaf !== "reducedPolicy") return undefined;
      return { category: "motion", policy: DEFAULT_REDUCED_MOTION_POLICY };
    }
    default:
      return undefined;
  }
}
