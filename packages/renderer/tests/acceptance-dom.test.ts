/**
 * DOM-level acceptance: fonts, overflow structure, equal stats, hanging badges.
 * Uses the same static-markup + Playwright path as renderToPng.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { flatTreeSchema } from "@fanos/dsl";
import { emitCss, loadSurfaces, loadTheme, LOCAL_ASSET_CONTEXT } from "@fanos/tokens";
import { FONT_FACE_CSS } from "../src/fonts.js";

const ROOT = process.cwd();
const CARD = join(ROOT, "../dsl/fixtures/player-card.json");
const DATA = join(ROOT, "fixtures/player-card.data.json");
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

describe.skipIf(!enabled)("DOM acceptance", () => {
  let browser: Browser;

  afterAll(async () => {
    await browser?.close();
  });

  it("asserts font, overflow, stat distribution, badge placement", async () => {
    browser = await chromium.launch({ headless: true });
    const tree = flatTreeSchema.parse(JSON.parse(readFileSync(CARD, "utf8")));
    const data = JSON.parse(readFileSync(DATA, "utf8"));
    const theme = loadTheme(THEME);
    const surfaces = loadSurfaces(SURFACES);
    const { css } = emitCss(theme, { surfaces, assets: LOCAL_ASSET_CONTEXT });
    const baseStyles = readFileSync(STYLES, "utf8");

    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { Render } = await import("../src/components/Render.js");
    const markup = renderToStaticMarkup(
      // designWidth exercises the real path: a 281-native card scaled to 534.
      createElement(Render, { tree, data, assets: LOCAL_ASSET_CONTEXT, width: 534, designWidth: 281 }),
    );

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>${FONT_FACE_CSS}${css}${baseStyles}
html,body{margin:0;padding:0} body{width:534px}</style></head>
<body>${markup}</body></html>`;

    const server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/" || url.startsWith("/?")) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }
      let filePath = url.split("?")[0] ?? "/";
      if (filePath.startsWith("/public/")) filePath = join(PUBLIC, filePath.slice("/public/".length));
      else filePath = join(PUBLIC, filePath);
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const ext = filePath.split(".").pop();
      const type =
        ext === "woff2" ? "font/woff2" : ext === "png" ? "image/png" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": type });
      res.end(readFileSync(filePath));
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;

    const page = await browser.newPage({ viewport: { width: 600, height: 800 }, deviceScaleFactor: 1 });
    try {
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(async () => {
        await Promise.all(
          Array.from(document.images).map((img) =>
            img.complete
              ? Promise.resolve()
              : new Promise<void>((res) => {
                  img.onload = () => res();
                  img.onerror = () => res();
                }),
          ),
        );
      });

      const result = await page.evaluate(() => {
        const name = document.querySelector('[data-fos-id="name"]') as HTMLElement | null;
        const card = document.querySelector('[data-fos-id="card"]') as HTMLElement | null;
        // The card body is its own node now, not a surface on the Overlay.
        const bodyEl = document.querySelector('[data-fos-id="card_bg"]') as HTMLElement | null;
        const badges = document.querySelector('[data-fos-id="badges"]') as HTMLElement | null;
        const stats = ["stat_matches", "stat_runs", "stat_strike_rate"].map(
          (id) => document.querySelector(`[data-fos-id="${id}"]`) as HTMLElement | null,
        );

        const nameFont = name ? getComputedStyle(name).fontFamily : "";
        const cardOverflow = card ? getComputedStyle(card).overflow : "";
        const cardOverflowX = card ? getComputedStyle(card).overflowX : "";
        const bodyRect = bodyEl?.getBoundingClientRect();
        const bodyClass = bodyEl?.className ?? "";
        const bodyPosition = bodyEl ? getComputedStyle(bodyEl).position : "";

        const cardRect = card?.getBoundingClientRect();
        const badgesRect = badges?.getBoundingClientRect();
        const statWidths = stats.map((el) => el?.getBoundingClientRect().width ?? 0);

        // `role` is the vertical BOWLER label, anchored mid-start.
        const role = document.querySelector('[data-fos-id="role"]') as HTMLElement | null;
        const roleInner = role?.querySelector("span") as HTMLElement | null;
        const roleRect = role?.getBoundingClientRect();

        return {
          nameFont,
          cardOverflow,
          cardOverflowX,
          bodyClass,
          bodyPosition,
          cardLeft: cardRect?.left ?? 0,
          cardRight: cardRect?.right ?? 0,
          cardTop: cardRect?.top ?? 0,
          cardHeight: cardRect?.height ?? 0,
          cardWidth: cardRect?.width ?? 0,
          badgesLeft: badgesRect?.left ?? 0,
          badgesRight: badgesRect?.right ?? 0,
          statWidths,
          clipAttr: card?.getAttribute("data-fos-clip"),
          bodyW: bodyRect?.width ?? 0,
          bodyH: bodyRect?.height ?? 0,
          bodyTopOffset: bodyRect && cardRect ? bodyRect.top - cardRect.top : -1,
          roleLeft: roleRect?.left ?? 0,
          roleCentreY: roleRect ? roleRect.top + roleRect.height / 2 : 0,
          roleWidth: roleRect?.width ?? 0,
          roleHeight: roleRect?.height ?? 0,
          roleOuterWritingMode: role ? getComputedStyle(role).writingMode : "",
          roleInnerWritingMode: roleInner ? getComputedStyle(roleInner).writingMode : "",
        };
      });

      // Font: Bakbak One must be the computed family for the name (dp_2_regular).
      expect(result.nameFont.toLowerCase()).toContain("bakbak one");

      // Cutout may overflow: overlay not clipped; surface layer is.
      expect(result.clipAttr).toBe("false");
      expect(result.cardOverflow === "visible" || result.cardOverflowX === "visible").toBe(true);
      // Card body: its own absolutely-placed node carrying the surface, 281x353
      // at y=61 of a 281x412 frame (scaled here by the 534 render width).
      expect(result.bodyClass).toContain("fos-surface-card_player");
      expect(result.bodyPosition).toBe("absolute");
      const k = result.cardWidth / 281;
      expect(result.bodyW).toBeCloseTo(281 * k, 0);
      expect(result.bodyH).toBeCloseTo(353 * k, 0);
      expect(result.bodyTopOffset).toBeCloseTo(61 * k, 0);

      // NOT equal thirds. The IR frames are hug/hug distributed by
      // SPACE_BETWEEN, so each group is as wide as its own label — "STRIKE RATE"
      // is much wider than "RUNS". The hand-authored fixture assumed equal
      // thirds; the real design does not.
      const [a, b, c] = result.statWidths;
      for (const w of [a, b, c]) expect(w).toBeGreaterThan(20);
      expect(Math.max(a!, b!, c!)).toBeGreaterThan(Math.min(a!, b!, c!) + 10);

      // Badges sit INSIDE the card, tight to the right edge — that is what the
      // design shows. They previously hung outside on a negative inline offset,
      // which also put them outside the root screenshot and therefore outside
      // anything the pixel diff could ever score.
      expect(result.badgesRight).toBeLessThanOrEqual(result.cardRight + 1);
      expect(result.badgesLeft).toBeGreaterThan(result.cardLeft + result.cardWidth * 0.6);

      // Vertical text must not hijack the anchor it sits on.
      //
      // `inset-inline-*` resolves against an element's OWN writing mode, so
      // putting `vertical-rl` on the anchored element swaps its axes and
      // `mid-start` silently renders top-centre. resolveAnchor is pure and
      // stayed correct throughout, which is exactly why this needs asserting on
      // real boxes rather than in a unit test.
      expect(result.roleOuterWritingMode).toBe("horizontal-tb");
      expect(result.roleInnerWritingMode).toBe("vertical-rl");
      // Taller than wide — it really is running vertically.
      expect(result.roleHeight).toBeGreaterThan(result.roleWidth);
      // `start` on the inline axis: within the left third of the card.
      expect(result.roleLeft).toBeLessThan(result.cardLeft + result.cardWidth / 3);
      // `center` on the block axis: within 10% of the card's vertical middle.
      const cardCentreY = result.cardTop + result.cardHeight / 2;
      expect(Math.abs(result.roleCentreY - cardCentreY)).toBeLessThan(result.cardHeight * 0.1);
    } finally {
      await page.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 60_000);
});
