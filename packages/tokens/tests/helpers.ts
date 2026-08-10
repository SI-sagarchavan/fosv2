/**
 * In-memory theme builders.
 *
 * Deliberately free of any filesystem import so `pure.test.ts` can exercise
 * `normalize.ts` and `validate.ts` without one.
 */

import type { RawThemeBody } from "../src/normalize.js";
import { normalizeTheme } from "../src/normalize.js";
import type { NormalizedTheme } from "../src/types.js";
import { parseSurfaceFile, type SurfaceSet } from "../src/raw-schema.js";

const TYPE = { size: 16, weight: 400, typeface: "Montserrat", line_height: 20, letter_spacing: 0 };

/** A minimal but complete theme: one token per category, no findings. */
export const CLEAN_THEME: RawThemeBody = {
  theme_name: "Test Theme",
  color: { light: { core_neu_00: "#ffffff", core_sec_500: "#2939a3", core_sec_600: "#243e70" } },
  spacing: { spacing_0: 0, spacing_4: 16, spacing_0_5: 2 },
  radius: { radius_xl: 16, radius_2xl: 24, radius_rounded: 999 },
  opacity: { opacity_0: 0, opacity_40: 40 },
  shadow: {
    light: {
      drop_shadow_md: { x: "3px", y: "3px", blur: "4px", spread: "0px", color: "#1a1a1a", opacity: 40, type: "drop" },
    },
  },
  gradient: {
    light: {
      gradient_sec_vert_1_gradient: {
        type: "linear-gradient",
        degree: 180,
        stops: [
          { color: "#1a1a1a", opacity: 0, percent: 0 },
          { color: "#1a1a1a", opacity: 100, percent: 100 },
        ],
      },
    },
  },
  typography_mobile: { body_md_regular: { ...TYPE, name: "body_md_regular" } },
  typography_tablet: { body_md_regular: { ...TYPE, name: "body_md_regular", size: 17 } },
  typography_desktop: { body_md_regular: { ...TYPE, name: "body_md_regular", size: 18 } },
};

export function makeTheme(overrides: Partial<RawThemeBody> = {}, id = "test-theme-id"): NormalizedTheme {
  return normalizeTheme(id, { ...CLEAN_THEME, ...overrides });
}

export function makeSurfaces(input: unknown): SurfaceSet {
  return parseSurfaceFile(input);
}

/**
 * The `gradient_nue_vert_1` shape from the fanxp-web-renderer export: five stops
 * whose percents run 20, 100, 100, 100, 100. Not present in Southern Brave, so
 * W6 needs a synthetic case to be covered at all.
 */
export const RUN_GRADIENT: RawThemeBody = {
  ...CLEAN_THEME,
  gradient: {
    light: {
      gradient_nue_vert_1_gradient: {
        type: "linear-gradient",
        degree: 180,
        stops: [
          { color: "#000000", opacity: 0, percent: 20 },
          { color: "#000000", opacity: 100, percent: 100 },
          { color: "#000000", opacity: 25, percent: 100 },
          { color: "#000000", opacity: 25, percent: 100 },
          { color: "#000000", opacity: 25, percent: 100 },
        ],
      },
      // Same run length, but every member of the run is identical.
      gradient_nue_vert_2_gradient: {
        type: "linear-gradient",
        degree: 180,
        stops: [
          { color: "#000000", opacity: 0, percent: 20 },
          { color: "#000000", opacity: 100, percent: 100 },
          { color: "#000000", opacity: 100, percent: 100 },
          { color: "#000000", opacity: 100, percent: 100 },
          { color: "#000000", opacity: 100, percent: 100 },
        ],
      },
    },
  },
};

/** Stops that move backwards: 0, 60, 30. */
export const BACKWARDS_GRADIENT: RawThemeBody = {
  ...CLEAN_THEME,
  gradient: {
    light: {
      gradient_sec_vert_1_gradient: {
        type: "linear-gradient",
        degree: 180,
        stops: [
          { color: "#000000", opacity: 100, percent: 0 },
          { color: "#000000", opacity: 100, percent: 60 },
          { color: "#000000", opacity: 100, percent: 30 },
        ],
      },
    },
  },
};

/** Three ordered layers, so the reversal on emit is observable. */
export const THREE_LAYER_SURFACES = {
  assets: { "texture.stripes": "/stripes.png", "texture.noise": "/noise.png" },
  surfaces: {
    card_player: {
      layers: [
        { type: "gradient", ref: "gradient.sec_vert_1" },
        { type: "image", ref: "asset.texture.stripes", fit: "cover", opacity: 30, blend: "overlay" },
        { type: "image", ref: "asset.texture.noise", opacity: 6, blend: "overlay" },
      ],
      borders: [
        { width: 1, color: "color.core_neu_00", opacity: 20, radius: "radius.2xl" },
        { width: 1, color: "color.core_neu_00", opacity: 10, inset: 8, radius: "radius.xl" },
      ],
      radius: "radius.2xl",
      shadow: "shadow.md",
    },
  },
};
