#!/usr/bin/env node
/**
 * Bundle one published FanOS page into a self-contained `pages/<name>.json` for the native preview.
 *
 * The app must not need Node-only parts of @fanos/tokens, so everything is resolved HERE, against the
 * repo's own packages: binding plan applied, `{data}` interpolated, every token turned into a concrete
 * value, every surface into concrete layers, button families into colours, and the font metrics the
 * renderer needs to reproduce cap-height trim.
 *
 *   node scripts/bundle-page.mjs --name squad --dir <workdir with out/2-agent.dsl.json ...>
 *   node scripts/bundle-page.mjs --name squad --url "http://localhost:3000/v1/preview/<run>?tree=..&theme=..&surfaces=..&plan=..&data=.."
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, "..");
const REPO = resolve(APP, "..");
const dsl = await import(join(REPO, "packages/dsl/dist/index.js"));
const tokens = await import(join(REPO, "packages/tokens/dist/index.js"));
const { interpolate } = await import(join(REPO, "packages/renderer/dist/index.js"));

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const name = args.name ?? "page";
const J = (f) => JSON.parse(readFileSync(f, "utf8"));

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------
let tree, theme, surfacesRaw, plan, data;
if (args.url) {
  const u = new URL(args.url);
  const api = (process.env.FANOS_API_URL ?? "http://localhost:4100").replace(/\/$/, "") + "/v1/projects/" + (process.env.FANOS_PROJECT ?? "default");
  const get = async (id) => (await fetch(`${api}/artifacts/${id}/content`)).json();
  const q = u.searchParams;
  [tree, theme, surfacesRaw] = await Promise.all([get(q.get("tree")), get(q.get("theme")), get(q.get("surfaces"))]);
  plan = q.get("plan") ? await get(q.get("plan")) : { bind: [] };
  data = q.get("data") ? await get(q.get("data")) : {};
} else if (args.dir) {
  const d = resolve(args.dir);
  tree = J(join(d, "out/2-agent.dsl.json"));
  theme = J(join(d, "theme.json"));
  surfacesRaw = J(join(d, "out/surfaces.json"));
  plan = existsSync(join(d, "out/plan.json")) ? J(join(d, "out/plan.json")) : { bind: [] };
  data = existsSync(join(d, "out/sample.json")) ? J(join(d, "out/sample.json")) : {};
} else {
  console.error("usage: bundle-page.mjs --name <n> (--dir <agent workdir> | --url <studio preview url>)");
  process.exit(1);
}

// loadTheme/loadSurfaces read files: hand them temp copies
const tmp = (obj, n) => { const p = join(tmpdir(), `fos-native-${process.pid}-${n}.json`); writeFileSync(p, JSON.stringify(obj)); return p; };
const th = tokens.loadTheme(tmp(theme, "theme"));
const surfaces = tokens.loadSurfaces(tmp(surfacesRaw, "surfaces"));
const reg = tokens.createRegistry(th, { surfaces });

// ---------------------------------------------------------------------------------------------
// Tree: bindings + data
// ---------------------------------------------------------------------------------------------
const bound = dsl.applyBindingPlan(tree, plan).tree;
const fill = (v) => {
  if (typeof v === "string" && v.includes("{")) return interpolate(v, data).value;
  if (Array.isArray(v)) return v.map(fill);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
  return v;
};
const nodes = bound.nodes.map((n) => ({ ...n, props: fill(n.props) }));

// ---------------------------------------------------------------------------------------------
// Tokens -> concrete values
// ---------------------------------------------------------------------------------------------
const out = { color: {}, space: {}, radius: {}, opacity: {}, gradient: {}, shadow: {}, type: {}, surface: {} };
const rgba = (hex, op = 100) => {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = (h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1) * (op / 100);
  return `rgba(${r},${g},${b},${+a.toFixed(3)})`;
};
function token(ref) {
  if (typeof ref !== "string" || !/^(color|space|radius|opacity|gradient|shadow|type)\./.test(ref)) return;
  const cat = ref.split(".")[0];
  if (out[cat][ref] !== undefined) return;
  let r; try { r = reg.resolve(ref); } catch { return; }
  if (!r) return;
  if (cat === "color") out.color[ref] = r.hex;
  else if (cat === "space" || cat === "radius") out[cat][ref] = r.px;
  else if (cat === "opacity") out.opacity[ref] = r.unit;
  else if (cat === "gradient") out.gradient[ref] = { degree: r.gradient.degree ?? 180, stops: r.gradient.stops.map((s) => ({ color: rgba(s.color, s.opacity), at: s.percent / 100 })) };
  else if (cat === "shadow") { const s = r.shadow; out.shadow[ref] = `${s.inset ? "inset " : ""}${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${rgba(s.color, s.opacity)}`; }
  else if (cat === "type") out.type[ref] = r.byBreakpoint;
}
function surface(ref) {
  if (typeof ref !== "string" || !ref.startsWith("surface.") || out.surface[ref]) return;
  const spec = surfaces.surfaces.get(ref.slice(8));
  if (!spec) return;
  const layers = [];
  for (const l of spec.layers ?? []) {
    if (l.type === "color") { token(l.ref); const hex = out.color[l.ref]; if (hex) layers.push({ type: "color", color: rgba(hex, l.opacity ?? 100) }); }
    else if (l.type === "gradient") { token(l.ref); const g = out.gradient[l.ref]; if (g) layers.push({ type: "gradient", ...g, opacity: (l.opacity ?? 100) / 100 }); }
    else if (l.type === "image") {
      const leaf = l.ref.replace(/^asset\./, "");
      const uri = surfaces.assets.get(leaf) ?? (/^(https?:|data:)/.test(l.ref) ? l.ref : undefined);
      if (uri) layers.push({ type: "image", uri, fit: l.fit ?? "cover", opacity: (l.opacity ?? 100) / 100 });
    }
  }
  const s = { layers };
  if (spec.radius) { token(spec.radius); s.radius = out.radius[spec.radius]; }
  if (spec.borders?.length) {
    const b = spec.borders[0]; token(b.color);
    s.border = { width: b.width, color: out.color[b.color] ? rgba(out.color[b.color], b.opacity ?? 100) : undefined, style: b.style ?? "solid" };
    if (b.radius) { token(b.radius); s.radius ??= out.radius[b.radius]; }
  }
  if (spec.shadow) { token(spec.shadow); s.shadow = out.shadow[spec.shadow]; }
  out.surface[ref] = s;
}
const walk = (v) => {
  if (typeof v === "string") { token(v); surface(v); }
  else if (Array.isArray(v)) v.forEach(walk);
  else if (v && typeof v === "object") Object.values(v).forEach(walk);
};
nodes.forEach((n) => walk(n.props));

// Buttons: the variant/style family -> concrete paints per state, and the label's type.
for (const n of nodes) {
  if (n.type !== "Button") continue;
  const fam = `${String(n.props.variant ?? "filled").replace(/-/g, "_")}_style_${n.props.styleN ?? 1}`;
  const pick = (part, state) => { const r = `color.button_${fam}_${part}_${state}`; token(r); return out.color[r]; };
  const typeRef = `type.button_${n.props.size ?? "md"}`; token(typeRef);
  n.props._native = {
    bg: pick("surface", "default"), bgPressed: pick("surface", "on_hover"), text: pick("text", "default"),
    border: pick("border", "default"), type: typeRef,
  };
}

// ---------------------------------------------------------------------------------------------
// Fonts: which files, and the metrics cap-height trim needs (hhea ascender/descender, OS/2 capHeight)
// ---------------------------------------------------------------------------------------------
const FONT_PKGS = { "Montserrat": "montserrat", "Bakbak One": "bakbak-one", "Inter": "inter", "Poppins": "poppins" };
const WEIGHT_DIR = { 100: "100Thin", 200: "200ExtraLight", 300: "300Light", 400: "400Regular", 500: "500Medium", 600: "600SemiBold", 700: "700Bold", 800: "800ExtraBold", 900: "900Black" };
function ttfMetrics(file) {
  const b = readFileSync(file); const n = b.readUInt16BE(4); const t = {};
  for (let i = 0; i < n; i++) { const o = 12 + i * 16; t[b.toString("ascii", o, o + 4)] = b.readUInt32BE(o + 8); }
  const upm = b.readUInt16BE(t["head"] + 18);
  const asc = b.readInt16BE(t["hhea"] + 4), desc = b.readInt16BE(t["hhea"] + 6);
  const os2 = t["OS/2"]; const ver = b.readUInt16BE(os2);
  const cap = ver >= 2 ? b.readInt16BE(os2 + 88) : Math.round(asc * 0.7);
  return { ascent: asc / upm, descent: -desc / upm, capHeight: cap / upm };
}
const fonts = {};
for (const spec of Object.values(out.type)) {
  for (const bp of Object.values(spec)) {
    const pkg = FONT_PKGS[bp.family]; if (!pkg) continue;
    const dir = join(APP, "node_modules/@expo-google-fonts", pkg);
    let w = WEIGHT_DIR[bp.weight] ?? "400Regular";
    if (!existsSync(join(dir, w))) w = readdirSync(dir).find((d) => /^\d00[A-Za-z]+$/.test(d)) ?? w;  // e.g. Bakbak One ships 400 only
    const ttf = readdirSync(join(dir, w)).find((f) => f.endsWith(".ttf"));
    const key = `${bp.family}|${bp.weight}`;
    fonts[key] = { name: ttf.replace(".ttf", ""), pkg, ...ttfMetrics(join(dir, w, ttf)) };
  }
}

// ---------------------------------------------------------------------------------------------
const root = nodes.find((n) => n.parent === null);
const width = typeof root?.props?.size?.w === "object" && root.props.size.w.raw ? root.props.size.w.raw : Number(args.width ?? 1366);
mkdirSync(join(APP, "pages"), { recursive: true });
const viewport = Number(args.viewport ?? Math.max(width, 1366));
writeFileSync(join(APP, "pages", `${name}.json`), JSON.stringify({ name, width, viewport, nodes, tokens: out, fonts }));

// pages/index.ts — a static registry, because Metro cannot require() a computed path
const pages = readdirSync(join(APP, "pages")).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
writeFileSync(join(APP, "pages", "index.ts"),
  "// generated by scripts/bundle-page.mjs\nimport type { Page } from \"../src/fos/types\";\n" +
  pages.map((p, i) => `import p${i} from "./${p}.json";`).join("\n") +
  `\n\nexport const PAGES: Record<string, Page> = {\n${pages.map((p, i) => `  ${JSON.stringify(p)}: p${i} as unknown as Page,`).join("\n")}\n};\n`);
const kb = (readFileSync(join(APP, "pages", `${name}.json`)).length / 1024).toFixed(0);
console.log(`pages/${name}.json — ${nodes.length} nodes, width ${width}, ${Object.keys(out.surface).length} surfaces, fonts ${Object.values(fonts).map((f) => f.name).join(", ")} — ${kb} KB`);
