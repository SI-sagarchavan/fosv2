/**
 * The only module in the package that touches the filesystem.
 *
 * `normalize.ts` and `validate.ts` are kept pure so their tests run against
 * in-memory objects; everything that needs a file goes through here.
 */

import { readFileSync } from "node:fs";
import type { NormalizedTheme } from "./types.js";
import { normalizeTheme } from "./normalize.js";
import { parseSurfaceFile, rawThemeFileSchema, type SurfaceSet } from "./raw-schema.js";

export function parseThemeJson(json: unknown): NormalizedTheme[] {
  const parsed = rawThemeFileSchema.parse(json);
  return Object.entries(parsed.tokens).map(([id, body]) => normalizeTheme(id, body));
}

/**
 * Read and normalize a theme export.
 *
 * The file is keyed by theme UUID and may hold more than one. Pass `themeId`
 * to disambiguate; with a single theme it is optional.
 */
export function loadTheme(path: string, themeId?: string): NormalizedTheme {
  const themes = parseThemeJson(JSON.parse(readFileSync(path, "utf8")));
  if (themes.length === 0) throw new Error(`${path}: no themes under "tokens"`);
  if (themeId) {
    const hit = themes.find((t) => t.id === themeId);
    if (!hit) throw new Error(`${path}: no theme with id "${themeId}" (have ${themes.map((t) => t.id).join(", ")})`);
    return hit;
  }
  if (themes.length > 1) {
    throw new Error(`${path}: holds ${themes.length} themes — pass --theme-id (${themes.map((t) => t.id).join(", ")})`);
  }
  return themes[0]!;
}

export function loadSurfaces(path: string): SurfaceSet {
  return parseSurfaceFile(JSON.parse(readFileSync(path, "utf8")));
}
