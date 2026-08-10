/**
 * Headless render via Playwright chromium.
 *
 * Boots a minimal Next route that renders the tree, waits for fonts and images,
 * screenshots the root element only (not the viewport).
 */

import { chromium, type Browser } from "playwright";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { FlatTree } from "@fanos/dsl";
import type { DataBag } from "../resolve/data.js";

export interface RenderToPngOptions {
  data?: DataBag;
  /** Pre-emitted theme CSS (from emitCss). Required for correct pixels. */
  themeCss: string;
  width: number;
  height?: number;
  /**
   * Page viewport width, which is what the emitted CSS media queries key off.
   *
   * Separate from `width` on purpose: a 534px card sitting on a 1440px desktop
   * page must resolve DESKTOP type, and tying the viewport to the card width
   * silently renders the whole card one breakpoint too small.
   */
  viewport?: number;
  /** Width the tree was designed at; scales the whole card. See Render. */
  designWidth?: number;
  /**
   * Page colour behind the tree. A card with transparent regions (this one
   * bleeds its cutout over the page) is scored against whatever sits behind it,
   * so a wrong page colour is a diff the tree can never win.
   */
  background?: string;
  deviceScaleFactor?: number;
  /** Extra HTML head content (font faces). */
  fontCss?: string;
  /** Base URL for resolving /public assets. Served from publicDir. */
  publicDir?: string;
}

/**
 * The package root, found by walking up for the directory that owns `public/`.
 *
 * A fixed `../..` is only correct when this module sits at `src/harness/`. Once
 * tsup bundles it into `dist/`, the same expression lands on `packages/`, and
 * every font, texture and the base stylesheet 404s — the CLI then renders a
 * layout-free page in a serif fallback while the vitest suite, which runs from
 * `src/`, stays green. Resolving by landmark makes both layouts work.
 */
function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "public")) && existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "renderToPng: could not locate the @fanos/renderer package root (no ancestor with public/ + package.json). Pass publicDir explicitly.",
  );
}

const PACKAGE_ROOT = findPackageRoot();

let sharedBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!sharedBrowser) {
    sharedBrowser = await chromium.launch({ headless: true });
  }
  return sharedBrowser;
}

export async function closeBrowser(): Promise<void> {
  if (sharedBrowser) {
    await sharedBrowser.close();
    sharedBrowser = null;
  }
}

/**
 * Render a flat tree to a PNG buffer of the root element.
 */
export async function renderToPng(
  tree: FlatTree,
  options: RenderToPngOptions,
): Promise<Buffer> {
  const { html, publicDir, viewport, width, height, deviceScaleFactor } = await buildPage(
    tree,
    options,
  );
  return withPage(
    html,
    publicDir,
    { width: viewport, height: height ?? Math.round(width * 1.4) },
    deviceScaleFactor,
    async (page) => {
      const root = page.locator("[data-fos-root]");
      const buf = await root.screenshot({ type: "png", omitBackground: false });
      return Buffer.from(buf);
    },
  );
}

interface BuiltPage {
  html: string;
  publicDir: string;
  viewport: number;
  width: number;
  height?: number;
  deviceScaleFactor: number;
}

/**
 * Build the standalone HTML for a tree.
 *
 * Shared by `renderToPng` and `measureNodeBoxes` so a screenshot and a
 * measurement can never disagree about what was rendered — which would make
 * every C2 result meaningless.
 */
async function buildPage(tree: FlatTree, options: RenderToPngOptions): Promise<BuiltPage> {
  const { width, height, deviceScaleFactor = 1, themeCss, fontCss = "", data } = options;
  const viewport = options.viewport ?? width;
  const publicDir = options.publicDir ?? join(PACKAGE_ROOT, "public");

  // Dynamic import so the harness stays usable from CLI without loading React
  // until needed. We render via ReactDOMServer into a static HTML page.
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { Render } = await import("../components/Render.js");
  const { LOCAL_ASSET_CONTEXT } = await import("@fanos/tokens");
  const { readFileSync: read } = await import("node:fs");
  // `dist/styles.css` first — it is what actually ships (`files` excludes src/).
  // Missing base styles are NOT survivable: overlay layering, anchor placement
  // and writing-mode all live there, so an empty string silently renders a
  // different page rather than a slightly wrong one.
  const stylesPath = [join(PACKAGE_ROOT, "dist/styles.css"), join(PACKAGE_ROOT, "src/styles.css")].find((p) =>
    existsSync(p),
  );
  if (!stylesPath) {
    throw new Error(
      `renderToPng: base stylesheet not found (looked in ${PACKAGE_ROOT}/dist and /src). Run \`pnpm --filter @fanos/renderer build\`.`,
    );
  }
  const baseStyles = read(stylesPath, "utf8");

  const markup = renderToStaticMarkup(
    createElement(Render, {
      tree,
      data,
      assets: LOCAL_ASSET_CONTEXT,
      width,
      ...(options.designWidth ? { designWidth: options.designWidth } : {}),
    }),
  );

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=${viewport}" />
<style>
${fontCss}
${themeCss}
${baseStyles}
html, body { margin: 0; padding: 0; background: ${options.background ?? "#0a0a0a"}; }
body { width: ${viewport}px; ${height ? `height: ${height}px;` : ""} }
</style>
</head>
<body>
${markup}
</body>
</html>`;

  return { html, publicDir, viewport, width, height, deviceScaleFactor };
}

/**
 * Load the page, wait for it to be measurable, hand it to `probe`, clean up.
 *
 * Fonts and images are awaited before anything reads the DOM: a fallback font
 * swap makes every text metric wrong, and an unloaded image has no intrinsic
 * size, so measuring early produces numbers that look plausible and are not.
 */
async function withPage<T>(
  html: string,
  publicDir: string,
  viewport: { width: number; height: number },
  deviceScaleFactor: number,
  probe: (page: import("playwright").Page) => Promise<T>,
): Promise<T> {
  const server = await serveHtml(html, publicDir);
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport, deviceScaleFactor });
  try {
    await page.goto(server.url, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(async () => {
      await Promise.all(
        Array.from(document.images).map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise<void>((res) => {
                img.addEventListener("load", () => res());
                img.addEventListener("error", () => res());
              }),
        ),
      );
    });
    return await probe(page);
  } finally {
    await page.close();
    await server.close();
  }
}

/** A measured element, in CSS px relative to the rendered root. */
export interface MeasuredBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Measure every `data-fos-id` element, relative to the render root.
 *
 * This is the other half of C2 in @fanos/conform: the IR knows where Figma put
 * each node, this knows where the browser actually put it, and the two only
 * mean anything together.
 *
 * Root-relative rather than viewport-relative so the numbers survive the page
 * padding, the scroll position and the `designWidth` scaler — all of which move
 * a card without changing its internal geometry.
 *
 * A node rendered more than once (Repeater) reports its FIRST box; repeated
 * instances map to different IR nodes and are C1's business, not C2's.
 */
export async function measureNodeBoxes(
  tree: FlatTree,
  options: RenderToPngOptions,
): Promise<MeasuredBox[]> {
  const { html, publicDir, viewport, width, height, deviceScaleFactor } = await buildPage(
    tree,
    options,
  );
  return withPage(
    html,
    publicDir,
    { width: viewport, height: height ?? Math.round(width * 1.4) },
    deviceScaleFactor,
    (page) =>
      page.evaluate(() => {
        const root = document.querySelector("[data-fos-root]");
        if (!root) return [] as MeasuredBox[];
        const origin = root.getBoundingClientRect();
        const seen = new Set<string>();
        const out: MeasuredBox[] = [];
        for (const el of Array.from(document.querySelectorAll("[data-fos-id]"))) {
          const id = el.getAttribute("data-fos-id")!;
          if (seen.has(id)) continue;
          seen.add(id);
          const r = el.getBoundingClientRect();
          out.push({
            id,
            x: r.left - origin.left,
            y: r.top - origin.top,
            w: r.width,
            h: r.height,
          });
        }
        return out;
      }) as Promise<MeasuredBox[]>,
  );
}

async function serveHtml(
  html: string,
  publicDir: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    if (url === "/" || url.startsWith("/?")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    // Map /public/... and /players/... to files.
    let filePath = url.split("?")[0] ?? "/";
    if (filePath.startsWith("/public/")) {
      filePath = join(publicDir, filePath.slice("/public/".length));
    } else {
      filePath = join(publicDir, filePath);
    }
    const resolved = resolve(filePath);
    if (!resolved.startsWith(resolve(publicDir)) || !existsSync(resolved)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const ext = resolved.split(".").pop()?.toLowerCase();
    const types: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      woff2: "font/woff2",
      css: "text/css",
      svg: "image/svg+xml",
    };
    res.writeHead(200, { "Content-Type": types[ext ?? ""] ?? "application/octet-stream" });
    res.end(readFileSync(resolved));
  });

  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("failed to bind harness server");
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    close: () =>
      new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
  };
}

/** Write a buffer to disk, creating parent dirs. */
export function writePng(path: string, buf: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
}
