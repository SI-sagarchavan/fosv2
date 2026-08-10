/**
 * Leading trim — measured in a real browser, because the whole point is a
 * layout effect no static assertion can see.
 *
 * Figma reports a TEXT node's height as roughly (lines - 1) * lineHeight +
 * capHeight; CSS wraps every line in a full line box, so half the leading hangs
 * above the first cap and below the last baseline. On the newsletter heading
 * that is ~13px of phantom space sitting exactly where the design put a 16px
 * gap, and it made the 190px band render 204px tall.
 *
 * `text-box: trim-both cap alphabetic` closes it — but it must NOT apply where
 * the box is clipped or rotated, which is what the last two cases pin down.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { flatTreeSchema } from "@fanos/dsl";
import { emitCss, loadSurfaces, loadTheme, LOCAL_ASSET_CONTEXT } from "@fanos/tokens";
import { FONT_FACE_CSS } from "../src/fonts.js";

const ROOT = process.cwd();
const THEME = join(ROOT, "../tokens/fixtures/southern-brave.json");
const SURFACES = join(ROOT, "../tokens/surfaces/southern-brave.json");
const PUBLIC = join(ROOT, "public");
const STYLES = join(ROOT, "src/styles.css");
const FONT = join(ROOT, "public/fonts/bakbak-one-400.woff2");

async function browserAvailable(): Promise<boolean> {
  if (!existsSync(FONT)) return false;
  try {
    const b = await chromium.launch({ headless: true });
    await b.close();
    return true;
  } catch {
    return false;
  }
}

const enabled = await browserAvailable();

async function serve(html: string): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    if (url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }
    const filePath = join(PUBLIC, url.startsWith("/public/") ? url.slice("/public/".length) : url);
    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const ext = filePath.split(".").pop();
    res.writeHead(200, {
      "Content-Type":
        ext === "woff2" ? "font/woff2" : ext === "png" ? "image/png" : "application/octet-stream",
    });
    res.end(readFileSync(filePath));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, port: (server.address() as { port: number }).port };
}

/** Render a fixture and hand the live page to `probe`. */
async function measure<T>(
  browser: Browser,
  fixture: string,
  width: number,
  probe: (page: import("playwright").Page) => Promise<T>,
): Promise<T> {
  const tree = flatTreeSchema.parse(
    JSON.parse(readFileSync(join(ROOT, `../dsl/fixtures/${fixture}.json`), "utf8")),
  );
  const data = JSON.parse(
    readFileSync(join(ROOT, `fixtures/${fixture}.data.json`), "utf8"),
  ) as Record<string, unknown>;
  const { css } = emitCss(loadTheme(THEME), {
    surfaces: loadSurfaces(SURFACES),
    assets: LOCAL_ASSET_CONTEXT,
  });

  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { Render } = await import("../src/components/Render.js");
  const markup = renderToStaticMarkup(
    createElement(Render, { tree, data, assets: LOCAL_ASSET_CONTEXT, width } as never),
  );

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>${FONT_FACE_CSS}${css}${readFileSync(STYLES, "utf8")}
html,body{margin:0;padding:0} body{width:${width}px}</style></head><body>${markup}</body></html>`;

  const { server, port } = await serve(html);
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
  });
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    return await probe(page);
  } finally {
    await page.close();
    server.close();
  }
}

describe.skipIf(!enabled)("leading trim", () => {
  let browser: Browser;
  afterAll(async () => {
    await browser?.close();
  });

  it("makes the newsletter band render at its Figma height", async () => {
    browser ??= await chromium.launch({ headless: true });
    const h = await measure(browser, "newsletter-signup", 1366, (page) =>
      page.evaluate(() => {
        const el = document.querySelector('[data-fos-id="section"]') as HTMLElement;
        return el.getBoundingClientRect().height;
      }),
    );
    // Figma frame 1:5093 is 1366x190. Untrimmed CSS gave 204.
    expect(h).toBeGreaterThan(186);
    expect(h).toBeLessThan(194);
  });

  it("trims the 2-line heading to cap-height, not to two full line boxes", async () => {
    browser ??= await chromium.launch({ headless: true });
    const box = await measure(browser, "newsletter-signup", 1366, (page) =>
      page.evaluate(() => {
        const el = document.querySelector('[data-fos-id="heading"]') as HTMLElement;
        return { h: el.getBoundingClientRect().height, lh: getComputedStyle(el).lineHeight };
      }),
    );
    const lineHeight = Number.parseFloat(box.lh);
    expect(lineHeight).toBeCloseTo(34, 0);
    // Two full line boxes would be 68; Figma reports 53 for this very node.
    expect(box.h).toBeLessThan(2 * lineHeight - 6);
    expect(box.h).toBeGreaterThan(lineHeight);
  });

  it("leaves CLAMPED text untrimmed — a cap-height top edge shears ascenders", async () => {
    browser ??= await chromium.launch({ headless: true });
    const probe = await measure(browser, "news-card", 379, (page) =>
      page.evaluate(() => {
        const el = document.querySelector(".fos-text-clamp") as HTMLElement;
        return {
          found: !!el,
          trim: getComputedStyle(el).getPropertyValue("text-box-trim"),
          // Clamping is what makes trimming destructive rather than cosmetic.
          overflow: getComputedStyle(el).overflow,
        };
      }),
    );
    expect(probe.found).toBe(true);
    expect(probe.overflow).toBe("hidden");
    expect(probe.trim).toBe("none");
  });

  it("leaves VERTICAL text untrimmed — trim collapses the outer box off-axis", async () => {
    browser ??= await chromium.launch({ headless: true });
    const probe = await measure(browser, "player-card", 281, (page) =>
      page.evaluate(() => {
        const el = document.querySelector('[data-fos-id="role"]') as HTMLElement;
        const r = el.getBoundingClientRect();
        return {
          classes: el.className,
          trim: getComputedStyle(el).getPropertyValue("text-box-trim"),
          taller: r.height > r.width,
        };
      }),
    );
    expect(probe.classes).toContain("fos-text-has-vertical");
    expect(probe.trim).toBe("none");
    // The regression this guards: trim shrank the box to one cap height while
    // the rotated inner span stayed 50px tall, so every anchor read from it lied.
    expect(probe.taller).toBe(true);
  });
});
