/**
 * The themes compiled into the plugin.
 *
 * Network access is for Surface Studio events, not for themes. Every theme the
 * plugin can check a file against is still bundled at build time by esbuild's
 * JSON loader.
 *
 * Adding a tenant is two lines: an import, and an entry in THEME_FILES. That is
 * the whole extension point, and it is deliberately dumb — a designer switching
 * tenants in the header is re-running reconciliation against a different set of
 * names, not loading anything.
 */
import { normalizeTheme, rawThemeFileSchema, type NormalizedTheme } from "@fanos/tokens";
import southernBrave from "@fanos/tokens/fixtures/southern-brave.json";

/** Raw theme exports, keyed by however they are named on disk. */
const THEME_FILES: ReadonlyArray<{ source: string; json: unknown }> = [
  { source: "southern-brave.json", json: southernBrave },
];

export interface ThemeChoice {
  id: string;
  name: string;
  slug: string;
  source: string;
}

let cache: Array<{ theme: NormalizedTheme; source: string }> | undefined;

/**
 * Normalizes every bundled theme once per session. `parseThemeJson` in
 * @fanos/tokens would do this, but it lives beside `readFileSync` and the Figma
 * sandbox has no filesystem — so the two pure halves are called directly.
 */
export function loadBundledThemes(): Array<{ theme: NormalizedTheme; source: string }> {
  if (cache) return cache;
  const out: Array<{ theme: NormalizedTheme; source: string }> = [];
  for (const file of THEME_FILES) {
    // A bundling or schema problem here used to surface as an empty theme picker
    // and nothing else. Naming the file that failed is the difference between a
    // five-minute fix and an afternoon.
    let parsed: { tokens: Record<string, unknown> };
    try {
      parsed = rawThemeFileSchema.parse(file.json) as { tokens: Record<string, unknown> };
    } catch (err) {
      throw new Error(
        `Bundled theme ${file.source} didn't parse: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const entries = Object.entries(parsed.tokens);
    if (entries.length === 0) {
      throw new Error(`Bundled theme ${file.source} has no themes under "tokens".`);
    }
    for (const [id, body] of entries) {
      out.push({ theme: normalizeTheme(id, body as never), source: file.source });
    }
  }
  if (out.length === 0) {
    throw new Error("No themes are bundled into this build — see src/themes.ts.");
  }
  cache = out;
  return out;
}

export function themeChoices(): ThemeChoice[] {
  return loadBundledThemes().map(({ theme, source }) => ({
    id: theme.id,
    name: theme.name,
    slug: theme.slug,
    source,
  }));
}

export function themeById(id: string): NormalizedTheme | undefined {
  return loadBundledThemes().find((entry) => entry.theme.id === id)?.theme;
}

export function defaultTheme(): NormalizedTheme {
  const themes = loadBundledThemes();
  if (themes.length === 0) throw new Error("No themes are bundled into this build.");
  return themes[0]!.theme;
}
