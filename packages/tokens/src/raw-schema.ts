/**
 * Zod schemas for the two authored inputs: the raw theme export and the
 * per-theme surfaces file.
 *
 * These are deliberately STRUCTURAL only. They reject a file that is the wrong
 * shape; they do not reject a malformed hex or a negative spacing value. Those
 * are lint findings with names (E5, E6, …) that `validate.ts` reports with
 * enough context to fix, and a Zod parse error would collapse them into an
 * unhelpful path string.
 *
 * Pure — no filesystem access lives here.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Raw theme
// ---------------------------------------------------------------------------

/** Lengths arrive either as numbers (`spacing_4: 16`) or px strings (`x: "3px"`). */
const length = z.union([z.number(), z.string()]);

export const rawShadowSchema = z.object({
  x: length,
  y: length,
  blur: length,
  spread: length,
  color: z.string(),
  opacity: z.number(),
  type: z.string(),
});

export const rawGradientStopSchema = z.object({
  color: z.string(),
  opacity: z.number(),
  percent: z.number(),
});

export const rawGradientSchema = z.object({
  type: z.string(),
  degree: z.number(),
  stops: z.array(rawGradientStopSchema),
});

export const rawTypographySchema = z.object({
  name: z.string().optional(),
  size: z.number(),
  weight: z.number(),
  typeface: z.string(),
  line_height: z.number(),
  letter_spacing: z.number(),
});

/** `light` / `dark`. Both optional and both routinely empty. */
const scoped = <T extends z.ZodTypeAny>(inner: T) =>
  z
    .object({
      light: z.record(inner).optional(),
      dark: z.record(inner).optional(),
    })
    .partial();

export const rawThemeBodySchema = z.object({
  theme_name: z.string().optional(),
  badge: z.record(z.record(z.unknown())).optional(),
  button: z.record(z.record(z.unknown())).optional(),
  color: scoped(z.string()).optional(),
  radius: z.record(z.number()).optional(),
  shadow: scoped(rawShadowSchema).optional(),
  opacity: z.record(z.number()).optional(),
  spacing: z.record(z.number()).optional(),
  gradient: scoped(rawGradientSchema).optional(),
  typography_mobile: z.record(rawTypographySchema).optional(),
  typography_tablet: z.record(rawTypographySchema).optional(),
  typography_desktop: z.record(rawTypographySchema).optional(),
});

/** The whole file: `{ "tokens": { "<uuid>": { … } } }`. */
export const rawThemeFileSchema = z.object({
  tokens: z.record(rawThemeBodySchema),
});

export type RawThemeFile = z.infer<typeof rawThemeFileSchema>;

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export const surfaceLayerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("color"),
    ref: z.string(),
    /** 0-100. Defaults to fully opaque. */
    opacity: z.number().optional(),
    blend: z.string().optional(),
  }),
  z.object({
    type: z.literal("gradient"),
    ref: z.string(),
    opacity: z.number().optional(),
    blend: z.string().optional(),
  }),
  z.object({
    type: z.literal("image"),
    ref: z.string(),
    fit: z.enum(["cover", "contain", "repeat", "auto"]).optional(),
    opacity: z.number().optional(),
    blend: z.string().optional(),
  }),
]);

export const surfaceBorderSchema = z.object({
  width: z.number(),
  color: z.string(),
  /** 0-100. */
  opacity: z.number().optional(),
  /** px. Present on at most ONE border per surface — it renders via `::before`. */
  inset: z.number().optional(),
  radius: z.string().optional(),
  style: z.enum(["solid", "dashed", "dotted"]).optional(),
});

export const surfaceSchema = z.object({
  layers: z.array(surfaceLayerSchema).optional(),
  borders: z.array(surfaceBorderSchema).optional(),
  radius: z.string().optional(),
  shadow: z.string().optional(),
});

/**
 * The surfaces file accepts two shapes:
 *
 *   { "card_player": { … } }                        // flat, as originally specced
 *   { "assets": { … }, "surfaces": { "card": … } }  // wrapped
 *
 * The wrapped form exists because `asset.*` refs are not in the token export and
 * would otherwise be unresolvable (E2). `assets` maps a bare asset key
 * (`texture.stripes`) to a URL.
 */
export const surfaceFileSchema = z.union([
  z.object({
    assets: z.record(z.string()).optional(),
    surfaces: z.record(surfaceSchema),
  }),
  z.record(surfaceSchema),
]);

export type SurfaceLayer = z.infer<typeof surfaceLayerSchema>;
export type SurfaceBorder = z.infer<typeof surfaceBorderSchema>;
export type Surface = z.infer<typeof surfaceSchema>;

export interface SurfaceSet {
  surfaces: Map<string, Surface>;
  assets: Map<string, string>;
}

/** Collapse either accepted file shape into one representation. */
export function parseSurfaceFile(input: unknown): SurfaceSet {
  const parsed = surfaceFileSchema.parse(input);
  if (parsed && typeof parsed === "object" && "surfaces" in parsed && parsed.surfaces) {
    const wrapped = parsed as { assets?: Record<string, string>; surfaces: Record<string, Surface> };
    return {
      surfaces: new Map(Object.entries(wrapped.surfaces)),
      assets: new Map(Object.entries(wrapped.assets ?? {})),
    };
  }
  return {
    surfaces: new Map(Object.entries(parsed as Record<string, Surface>)),
    assets: new Map(),
  };
}
