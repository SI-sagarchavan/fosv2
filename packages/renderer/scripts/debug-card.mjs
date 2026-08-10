import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createServer } from "http";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { chromium } from "playwright";
import { flatTreeSchema } from "@fanos/dsl";
import { emitCss, loadTheme, loadSurfaces, LOCAL_ASSET_CONTEXT } from "@fanos/tokens";
import { Render, FONT_FACE_CSS } from "../dist/index.js";

const tree = flatTreeSchema.parse(
  JSON.parse(readFileSync(new URL("../../dsl/fixtures/player-card.json", import.meta.url), "utf8")),
);
const data = JSON.parse(readFileSync(new URL("../fixtures/player-card.data.json", import.meta.url), "utf8"));
const theme = loadTheme(new URL("../../tokens/fixtures/southern-brave.json", import.meta.url).pathname);
const surfaces = loadSurfaces(new URL("../../tokens/surfaces/southern-brave.json", import.meta.url).pathname);
const { css } = emitCss(theme, { surfaces, assets: LOCAL_ASSET_CONTEXT });
const base = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const markup = renderToStaticMarkup(
  createElement(Render, { tree, data, assets: LOCAL_ASSET_CONTEXT, width: 534 }),
);

const roleMatch = markup.match(/<span[^>]*data-fos-id="role"[^>]*>|<span[^>]*style="[^"]*"[^>]*data-fos-id="role"/);
console.log("role fragment:", markup.includes('data-fos-id="role"') ? markup.slice(markup.indexOf("role") - 200, markup.indexOf("role") + 200) : "missing");

const html = `<!DOCTYPE html><html><head><style>
${FONT_FACE_CSS}${css}${base}
body{margin:0;background:#111;width:534px}
</style></head><body>${markup}</body></html>`;

const publicDir = join(process.cwd(), "public");
const srv = createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/" || url.startsWith("/?")) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }
  let filePath = url.split("?")[0] ?? "/";
  if (filePath.startsWith("/public/")) filePath = join(publicDir, filePath.slice("/public/".length));
  else filePath = join(publicDir, filePath);
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("missing " + filePath);
    return;
  }
  res.end(readFileSync(filePath));
});

await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 600, height: 800 } });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);

const info = await page.evaluate(() => {
  const layer = document.querySelector("[data-fos-surface-layer]");
  const paint = document.querySelector("[data-fos-surface]");
  const role = document.querySelector('[data-fos-id="role"]');
  const card = document.querySelector('[data-fos-id="card"]');
  const cs = paint ? getComputedStyle(paint) : null;
  const ls = layer ? getComputedStyle(layer) : null;
  return {
    layer: layer
      ? {
          pos: ls.position,
          overflow: ls.overflow,
          w: layer.getBoundingClientRect().width,
          h: layer.getBoundingClientRect().height,
        }
      : null,
    paint: paint
      ? {
          pos: cs.position,
          bg: cs.backgroundImage.slice(0, 200),
          radius: cs.borderRadius,
          w: paint.getBoundingClientRect().width,
          h: paint.getBoundingClientRect().height,
        }
      : null,
    role: role
      ? {
          transform: getComputedStyle(role).transform,
          writingMode: getComputedStyle(role).writingMode,
          style: role.getAttribute("style"),
        }
      : null,
    card: card
      ? {
          w: card.getBoundingClientRect().width,
          h: card.getBoundingClientRect().height,
          ar: getComputedStyle(card).aspectRatio,
        }
      : null,
  };
});
console.log(JSON.stringify(info, null, 2));
await page.locator("[data-fos-root]").screenshot({ path: "out/debug-card.png" });
await browser.close();
srv.close();
console.log("wrote out/debug-card.png");
