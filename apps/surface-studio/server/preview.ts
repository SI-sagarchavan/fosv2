/**
 * Server-side SDUI preview: a run's compiled tree, as a page.
 *
 * Rendered here rather than in the board's bundle for three reasons:
 *
 *   1. `@fanos/tokens` reaches for `node:fs` on the theme-loading path. In Node
 *      that is simply correct; in a browser bundle it needs the same stubbing
 *      dance the Figma plugin has to do, for no gain.
 *   2. The renderer's stylesheet is global — `[data-fos-root]`, font faces, a
 *      `:root` block full of theme variables. Dropped into the board's own
 *      document it would style the board. An iframe is a real style boundary.
 *   3. It is what the Playwright harness already does. Preview and screenshot
 *      diverging would make the fidelity numbers describe a page nobody sees.
 *
 * The HTML mirrors `renderToPng`'s `buildPage`: same font CSS, same emitted
 * theme CSS, same base stylesheet, same order. That is deliberate — this is a
 * second consumer of one recipe, not a second recipe.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { FlatTree } from "@fanos/dsl";
import { FONT_FACE_CSS, Render } from "@fanos/renderer";
import {
  emitCss,
  LOCAL_ASSET_CONTEXT,
  parseSurfaceFile,
  parseThemeJson,
  type AssetContext,
  type SurfaceSet,
} from "@fanos/tokens";

/**
 * Fallback page width when the tree's root does not state one.
 *
 * Also the iframe's viewport, which is what the emitted media queries key off
 * — a preview at 800 would resolve tablet type for a desktop design and look
 * subtly wrong in a way that is very hard to attribute.
 */
const DEFAULT_WIDTH = 1280;

export interface PreviewSource {
  tree: unknown;
  theme: unknown;
  /**
   * The surface set the tree's `surface.*` refs resolve against.
   *
   * Not optional in practice: the compiler folds plate fills into surface refs,
   * so without this every background, button and overlay resolves to nothing
   * and the page renders as text floating on white.
   */
  surfaces?: unknown;
  /** Painted behind the tree; a compiled frame is often transparent. */
  background?: string;
  width?: number;
}

export interface RenderedPreview {
  html: string;
  width: number;
}

/**
 * Build the standalone preview document.
 *
 * Synchronous React only — `Render` is a Server Component in the RSC sense but
 * takes no async path, which is exactly why `renderToStaticMarkup` can drive it
 * outside Next.
 */
export async function renderPreview(source: PreviewSource): Promise<RenderedPreview> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");

  const themes = parseThemeJson(source.theme);
  const theme = themes[0];
  if (!theme) throw new Error("token set holds no themes");

  const surfaces = surfaceSetOf(source.surfaces);
  const assets = assetContextOf(surfaces);
  const { css } = emitCss(theme, {
    assets,
    scope: "root",
    ...(surfaces ? { surfaces } : {}),
  });

  const tree = source.tree as FlatTree;
  const width = source.width ?? rootWidthOf(tree) ?? DEFAULT_WIDTH;

  const markup = renderToStaticMarkup(
    createElement(Render, { tree, assets, width }),
  );

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=${width}" />
<style>
${FONT_FACE_CSS}
${css}
${baseStyles()}
html, body { margin: 0; padding: 0; background: ${source.background ?? "#ffffff"}; }
body { width: ${width}px; }
</style>
</head>
<body>
${markup}
</body>
</html>`;

  return { html, width };
}

/**
 * Parse a stored surface-set artifact into the form `emitCss` wants.
 *
 * `parseSurfaceFile` rather than a hand-rolled shape check: it is the same
 * parser the CLI and the harness use, and it validates each spec. A surface the
 * compiler derived but that does not satisfy the schema should fail loudly here
 * rather than emit no CSS and leave a blank plate to be explained later.
 *
 * Returns null for a run that stored no set — those predate the pipeline
 * storing one, and they render plateless rather than not at all.
 */
/**
 * Asset refs -> URLs, from the run's own surface set and nothing else.
 *
 * This used to seed a table of hardcoded Southern Brave URLs, which meant a
 * preview of ANY tenant's frame painted their listing pattern wherever a
 * texture ref appeared. The run resolves its own assets now — see the
 * `AssetPublisher` port — so whatever is in the set is what the designer
 * actually marked.
 *
 * `data:` is accepted alongside `http(s):`, because the default publisher
 * inlines the bytes: that is what makes a preview work with no credential and
 * no round trip back to the control plane. A ref with no entry resolves through
 * the CDN convention in `LOCAL_ASSET_CONTEXT` and, failing that, renders as
 * nothing — which is the honest outcome for an asset nobody can find.
 */
function assetContextOf(surfaces: SurfaceSet | null): AssetContext {
  const urls: Record<string, string> = {};
  if (surfaces) {
    for (const [leaf, url] of surfaces.assets) {
      if (typeof url === "string" && /^(?:https?:|data:)/.test(url)) {
        urls[leaf] = url;
        urls[`asset.${leaf}`] = url;
      }
    }
  }
  return { ...LOCAL_ASSET_CONTEXT, urls };
}

function surfaceSetOf(value: unknown): SurfaceSet | null {
  if (!value || typeof value !== "object") return null;

  const set = value as { surfaces?: unknown };
  if (!set.surfaces || typeof set.surfaces !== "object") return null;
  if (Object.keys(set.surfaces as object).length === 0) return null;

  return parseSurfaceFile(value);
}

/**
 * The width the frame was designed at, taken from the root node.
 *
 * The compiler records an unbound width as `{_unbound: true, raw: 1170}` — the
 * raw pixel value it could not tie to a token. For a preview that number is
 * exactly right: it is the Figma frame's width.
 */
function rootWidthOf(tree: FlatTree): number | null {
  const nodes = (tree as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return null;

  const root = nodes.find((n) => (n as { parent?: unknown }).parent === null);
  const w = (root as { props?: { size?: { w?: unknown } } } | undefined)?.props?.size?.w;

  if (typeof w === "number" && w > 0) return Math.round(w);
  if (w && typeof w === "object" && "raw" in w) {
    const raw = Number((w as { raw: unknown }).raw);
    if (Number.isFinite(raw) && raw > 0) return Math.round(raw);
  }
  return null;
}

// ---------------------------------------------------------------------------
// package assets
// ---------------------------------------------------------------------------

/**
 * The renderer package root, located by landmark rather than by counting `..`.
 *
 * Same reasoning as the harness: the number of levels between this file and the
 * package root differs between running from source and running from a bundle,
 * and getting it wrong renders a layout-free page in a fallback font rather
 * than failing.
 */
function rendererRoot(): string {
  const require = createRequire(import.meta.url);
  // `./styles.css` is in the package's `exports`, so it resolves where
  // `package.json` would not.
  let dir = dirname(require.resolve("@fanos/renderer/styles.css"));

  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "public")) && existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("preview: could not locate the @fanos/renderer package root");
}

let cachedRoot: string | null = null;

function packageRoot(): string {
  cachedRoot ??= rendererRoot();
  return cachedRoot;
}

/**
 * The renderer's base stylesheet. `dist/` first: that is what ships, and the
 * harness makes the same choice for the same reason. Missing base styles are
 * not survivable — overlay layering and anchor placement live there — so this
 * throws rather than rendering a subtly different page.
 */
function baseStyles(): string {
  const root = packageRoot();
  const path = [join(root, "dist/styles.css"), join(root, "src/styles.css")].find((p) =>
    existsSync(p),
  );
  if (!path) {
    throw new Error(
      "preview: @fanos/renderer base stylesheet not found — run `pnpm --filter @fanos/renderer build`",
    );
  }
  return readFileSync(path, "utf8");
}

/**
 * Resolve a `/public/...` URL to a file inside the renderer package.
 *
 * The emitted CSS asks for `/public/fonts/...` and `/public/local/textures/...`
 * verbatim, so serving the directory at that exact path means no URL rewriting
 * — and no class of bug where a rewrite misses one prefix.
 *
 * Returns null for anything that escapes the directory.
 */
export function resolvePublicAsset(urlPath: string): { path: string; type: string } | null {
  const relative = decodeURIComponent(urlPath.replace(/^\/public\//, ""));
  const base = join(packageRoot(), "public");
  const path = resolve(base, normalize(relative));

  if (!path.startsWith(base + sep)) return null;
  if (!existsSync(path)) return null;

  return { path, type: contentType(path) };
}

const TYPES: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".css": "text/css",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot >= 0 ? TYPES[path.slice(dot).toLowerCase()] : undefined) ?? "application/octet-stream";
}

/** Only used to keep the bundler honest about this file being server-side. */
export const PREVIEW_MODULE = fileURLToPath(import.meta.url);
