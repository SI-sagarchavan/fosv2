/**
 * FanOS DSL -> React Native.
 *
 * Mirrors @fanos/renderer's semantics, not its CSS:
 *   - Stack = flexbox (column by default, like the DSL); Overlay = a box whose `place`d children are absolute.
 *   - Yoga does not shrink flex items by default (the web does), so children get flexShrink 1 unless an
 *     explicit main-axis size pins them — the same rule resolve/style.ts applies on the web.
 *   - Surfaces paint as layers UNDER the children: colour, linear gradient, image (our CSS backgrounds).
 *   - Text: cap-height trim from the font's own metrics (the web uses `text-box`); vertical orientation by
 *     rotating an inner text inside a box of the transposed size, aligned along the reading axis.
 */
import React, { createContext, useContext, useMemo } from "react";
import { Text as RNText, View, Pressable, type ViewStyle, type TextStyle } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import type { FlatNode, Page, Surface, TypeSpec } from "./types";

interface Ctx {
  page: Page;
  kids: Map<string | null, FlatNode[]>;
  bp: "mobile" | "tablet" | "desktop";
}
const PageCtx = createContext<Ctx | null>(null);
const useCtx = () => useContext(PageCtx)!;

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------
function resp(v: any, bp: Ctx["bp"]): any {
  if (v && typeof v === "object" && "base" in v && !("raw" in v)) {
    if (bp === "desktop" && v.lg !== undefined) return v.lg;
    if (bp !== "mobile" && v.md !== undefined) return v.md;
    return v.base;
  }
  return v;
}
function num(v: any, ctx: Ctx): number | undefined {
  v = resp(v, ctx.bp);
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && typeof v.raw === "number") return v.raw;
  if (typeof v === "string") {
    if (v.startsWith("space.")) return ctx.page.tokens.space[v];
    if (v.startsWith("-space.")) return -(ctx.page.tokens.space[v.slice(1)] ?? 0);
    if (v.startsWith("radius.")) return ctx.page.tokens.radius[v];
  }
  return undefined;
}
const color = (ref: any, ctx: Ctx) => (typeof ref === "string" ? ctx.page.tokens.color[ref] : undefined);

// ---------------------------------------------------------------------------------------------
// Layout: size, space, place — the same decisions as resolve/style.ts and resolve/anchor.ts
// ---------------------------------------------------------------------------------------------
type Parent = { kind: "row" | "column" | "overlay" | "root" };

function layout(p: Record<string, any>, parent: Parent, ctx: Ctx): ViewStyle {
  const s: ViewStyle = {};
  const flexChild = parent.kind === "row" || parent.kind === "column";
  if (flexChild) s.flexShrink = 1;

  const size = p.size ?? {};
  if (size.w !== undefined) {
    const w = resp(size.w, ctx.bp);
    if (w === "full" && parent.kind === "row") { s.flexGrow = 1; s.flexBasis = 0; s.minWidth = 0; }
    else if (w === "full") s.width = "100%";
    else if (w !== "auto") { const n = num(w, ctx); if (n !== undefined) { s.width = n; if (parent.kind === "row") s.flexShrink = 0; } }
  }
  if (size.h !== undefined) {
    const h = resp(size.h, ctx.bp);
    if (h === "full" && parent.kind === "column") { s.flexGrow = 1; s.flexBasis = 0; s.minHeight = 0; }
    else if (h === "full" && parent.kind === "row") s.alignSelf = "stretch";
    else if (h === "full") s.height = "100%";
    else if (h !== "auto") { const n = num(h, ctx); if (n !== undefined) { s.height = n; if (parent.kind === "column") s.flexShrink = 0; } }
  }
  for (const [k, rn] of [["minW", "minWidth"], ["maxW", "maxWidth"], ["minH", "minHeight"], ["maxH", "maxHeight"]] as const) {
    const n = num(size[k], ctx); if (n !== undefined) (s as any)[rn] = n;
  }
  if (typeof size.ratio === "string") { const [a, b] = size.ratio.split("/").map(Number); if (a && b) s.aspectRatio = a / b; }

  const sp = p.space ?? {};
  const pad = (k: string) => num(sp[k], ctx);
  const all = pad("p"), px = pad("px"), py = pad("py");
  s.paddingTop = pad("pt") ?? py ?? all; s.paddingBottom = pad("pb") ?? py ?? all;
  s.paddingLeft = pad("pl") ?? px ?? all; s.paddingRight = pad("pr") ?? px ?? all;
  const m = (k: string) => num(sp[k], ctx);
  if (m("mt") !== undefined) s.marginTop = m("mt"); if (m("mb") !== undefined) s.marginBottom = m("mb");
  if (m("ml") !== undefined) s.marginLeft = m("ml"); if (m("mr") !== undefined) s.marginRight = m("mr");

  if (p.place?.anchor) Object.assign(s, anchor(p.place, ctx));
  if (p.clip === true) s.overflow = "hidden";
  return s;
}

const AXES: Record<string, [string, string]> = {
  fill: ["both", "both"], "top-start": ["start", "start"], "top-center": ["start", "center"], "top-end": ["start", "end"],
  "top-fill": ["start", "both"], "mid-start": ["center", "start"], center: ["center", "center"], "mid-end": ["center", "end"],
  "mid-fill": ["center", "both"], "bottom-start": ["end", "start"], "bottom-center": ["end", "center"],
  "bottom-end": ["end", "end"], "bottom-fill": ["end", "both"],
};
function anchor(place: any, ctx: Ctx): ViewStyle {
  const [block, inline] = AXES[place.anchor] ?? AXES["top-start"];
  const b = num(place.offset?.block, ctx) ?? 0, i = num(place.offset?.inline, ctx) ?? 0;
  const s: ViewStyle = { position: "absolute" };
  if (block === "start") s.top = b; else if (block === "end") s.bottom = b; else if (block === "both") { s.top = b; s.bottom = b; } else s.top = "50%";
  if (inline === "start") s.left = i; else if (inline === "end") s.right = i; else if (inline === "both") { s.left = i; s.right = i; } else s.left = "50%";
  const t: any[] = [];
  if (inline === "center") t.push({ translateX: "-50%" });
  if (block === "center") t.push({ translateY: "-50%" });
  if (t.length) s.transform = t;
  if (place.z !== undefined) s.zIndex = place.z;
  return s;
}

// ---------------------------------------------------------------------------------------------
// Surfaces: layers under the children
// ---------------------------------------------------------------------------------------------
function surfaceOf(p: Record<string, any>, ctx: Ctx): Surface | undefined {
  const ref = resp(p.surface, ctx.bp);
  return typeof ref === "string" ? ctx.page.tokens.surface[ref] : undefined;
}
function surfaceStyle(sf: Surface | undefined): ViewStyle {
  if (!sf) return {};
  const s: ViewStyle = {};
  if (sf.radius !== undefined) s.borderRadius = Math.min(sf.radius, 9999);
  if (sf.border?.width) { s.borderWidth = sf.border.width; s.borderColor = sf.border.color; s.borderStyle = (sf.border.style as any) ?? "solid"; }
  if (sf.shadow) (s as any).boxShadow = sf.shadow;
  const solid = sf.layers.length === 1 && sf.layers[0].type === "color" ? sf.layers[0].color : undefined;
  if (solid) s.backgroundColor = solid;
  return s;
}
function Layers({ sf }: { sf?: Surface }) {
  if (!sf || (sf.layers.length === 1 && sf.layers[0].type === "color")) return null;
  const r = sf.radius !== undefined ? Math.min(sf.radius, 9999) : undefined;
  const fill: ViewStyle = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: r, overflow: "hidden" };
  return (
    <>
      {sf.layers.map((l, k) => {
        if (l.type === "color") return <View key={k} pointerEvents="none" style={[fill, { backgroundColor: l.color }]} />;
        if (l.type === "gradient" && l.stops) {
          // CSS degrees: 0 = to top, clockwise. Direction vector in the unit square.
          const rad = ((l.degree ?? 180) * Math.PI) / 180, dx = Math.sin(rad), dy = -Math.cos(rad);
          return (
            <LinearGradient key={k} pointerEvents="none" style={[fill, { opacity: l.opacity ?? 1 }]}
              colors={l.stops.map((s) => s.color) as any} locations={l.stops.map((s) => s.at) as any}
              start={{ x: 0.5 - dx / 2, y: 0.5 - dy / 2 }} end={{ x: 0.5 + dx / 2, y: 0.5 + dy / 2 }} />
          );
        }
        if (l.type === "image" && l.uri)
          return <ExpoImage key={k} pointerEvents="none" source={{ uri: l.uri }} style={[fill as any, { opacity: l.opacity ?? 1 }]}
            contentFit={l.fit === "repeat" ? "none" : ((l.fit as any) ?? "cover")} />;
        return null;
      })}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------------------------
function Children({ id, parent }: { id: string; parent: Parent }) {
  const ctx = useCtx();
  return <>{(ctx.kids.get(id) ?? []).map((k) => <Node key={k.id} node={k} parent={parent} />)}</>;
}

const ALIGN: Record<string, ViewStyle["alignItems"]> = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch", baseline: "baseline" };
const JUSTIFY: Record<string, ViewStyle["justifyContent"]> = { start: "flex-start", center: "center", end: "flex-end", between: "space-between", around: "space-around", evenly: "space-evenly" };

function Node({ node, parent }: { node: FlatNode; parent: Parent }) {
  const ctx = useCtx();
  const p = node.props;
  const sf = surfaceOf(p, ctx);
  const base = [layout(p, parent, ctx), surfaceStyle(sf)];

  switch (node.type) {
    case "Stack": {
      const dir = resp(p.direction, ctx.bp) === "row" ? "row" : "column";
      const st: ViewStyle = {
        flexDirection: dir,
        gap: num(p.gap, ctx),
        alignItems: ALIGN[resp(p.align, ctx.bp)] ?? "stretch",
        justifyContent: JUSTIFY[resp(p.justify, ctx.bp)] ?? "flex-start",
        flexWrap: resp(p.wrap, ctx.bp) ? "wrap" : "nowrap",
      };
      return (
        <View style={[...base, st]}>
          <Layers sf={sf} />
          <Children id={node.id} parent={{ kind: dir }} />
        </View>
      );
    }
    case "Overlay":
    case "Box":
    case "Section":
      return (
        <View style={[...base, node.type === "Overlay" ? { position: (p.place?.anchor ? "absolute" : "relative") } : null]}>
          <Layers sf={sf} />
          <Children id={node.id} parent={{ kind: node.type === "Overlay" ? "overlay" : "column" }} />
        </View>
      );
    case "Text":
      return <FosText node={node} parent={parent} />;
    case "Image": {
      const uri = typeof p.src === "string" && p.src ? p.src : undefined;
      const fit = p.fit === "fill" ? "fill" : p.fit === "contain" ? "contain" : p.fit === "none" ? "none" : "cover";
      const style: ViewStyle = { ...(p.place?.anchor && !p.size ? { width: "100%", height: "100%" } : {}) };
      return (
        <View style={[...base, style, { overflow: sf?.radius ? "hidden" : undefined }]}>
          {uri ? <ExpoImage source={{ uri }} style={{ width: "100%", height: "100%" }} contentFit={fit as any}
            contentPosition={typeof p.position === "string" ? (p.position.replace("-", " ") as any) : undefined} /> : null}
        </View>
      );
    }
    case "Icon":
      return <FosIcon node={node} parent={parent} />;
    case "Divider": {
      const vertical = p.orientation === "vertical";
      const th = sf?.border?.width ?? 1;
      return <View style={[layout(p, parent, ctx), {
        backgroundColor: color(p.tone, ctx) ?? sf?.border?.color ?? "rgba(0,0,0,0.2)",
        opacity: typeof p.opacity === "string" ? ctx.page.tokens.opacity[p.opacity] ?? 1 : 1,
        ...(vertical ? { width: th, alignSelf: "stretch" } : { height: th, width: p.size?.w ? undefined : "100%" }),
      }]} />;
    }
    case "Button":
      return <FosButton node={node} parent={parent} />;
    default:
      // Not yet in the native vocabulary (Grid, Carousel, Repeater...): keep the box so layout holds.
      return <View style={base}><Children id={node.id} parent={{ kind: "column" }} /></View>;
  }
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------
function typeOf(ref: any, ctx: Ctx): TypeSpec | undefined {
  const spec = typeof ref === "string" ? ctx.page.tokens.type[ref] : undefined;
  return spec?.[ctx.bp] ?? spec?.desktop;
}
function textStyle(t: TypeSpec | undefined, ctx: Ctx): TextStyle {
  if (!t) return {};
  const f = ctx.page.fonts[`${t.family}|${t.weight}`];
  return {
    fontFamily: f?.name ?? t.family,
    fontSize: t.size,
    lineHeight: t.lineHeight,
    letterSpacing: (t.letterSpacing ?? 0) * t.size,
  };
}
const CASE: Record<string, TextStyle["textTransform"]> = { upper: "uppercase", lower: "lowercase", title: "capitalize", none: "none" };

/** CSS `text-box: trim-both cap alphabetic`, from the font's own metrics: cut the half-leading plus the
 *  space above cap height at the top, and everything below the baseline at the bottom. */
function trimMargins(t: TypeSpec, ctx: Ctx): { marginTop: number; marginBottom: number } {
  const f = ctx.page.fonts[`${t.family}|${t.weight}`];
  if (!f) return { marginTop: 0, marginBottom: 0 };
  const half = (t.lineHeight - (f.ascent + f.descent) * t.size) / 2;
  return { marginTop: -(half + (f.ascent - f.capHeight) * t.size), marginBottom: -(half + f.descent * t.size) };
}

function FosText({ node, parent }: { node: FlatNode; parent: Parent }) {
  const ctx = useCtx();
  const p = node.props;
  const t = typeOf(p.style, ctx);
  const ts: TextStyle = {
    ...textStyle(t, ctx),
    color: color(p.tone, ctx),
    textAlign: ({ start: "left", center: "center", end: "right" } as const)[resp(p.align, ctx.bp) as "start"] ?? "left",
    textTransform: CASE[p.textCase] ?? "none",
  };
  const lines = typeof p.truncate === "number" ? p.truncate : p.wrap === false ? 1 : undefined;
  const content = String(p.content ?? "").replace(/\r/g, "");

  if (p.orientation === "vertical-up" || p.orientation === "vertical-down") {
    // Rotate an inner text laid out at the transposed size; alignment runs along the reading axis.
    // The slot is Figma's trimmed box (8px wide for a 12px label). Lay the line out at its FULL line
    // height — a single-line Text clips to its box, and 8px cuts through the glyphs — then rotate it about
    // its centre, which sits on the slot's centre.
    const box = layout(p, parent, ctx);
    const W = (box.width as number) ?? 0, H = (box.height as number) ?? 0;
    const LH = t?.lineHeight ?? W;
    const deg = p.orientation === "vertical-up" ? "-90deg" : "90deg";
    return (
      <View style={[box, { overflow: "visible" }]}>
        <View style={{ position: "absolute", width: H, height: LH, left: W / 2 - H / 2, top: H / 2 - LH / 2, transform: [{ rotate: deg }], justifyContent: "center" }}>
          <RNText numberOfLines={1} style={[ts, { width: H }]}>{content}</RNText>
        </View>
      </View>
    );
  }

  const trim = p.trim === "none" || !t || typeof p.truncate === "number" ? null : trimMargins(t, ctx);
  return (
    <View style={layout(p, parent, ctx)}>
      <RNText numberOfLines={lines} style={[ts, trim ?? null]}>{content}</RNText>
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Icons & buttons — glyphs are a stopgap until the SVG registry is ported (react-native-svg)
// ---------------------------------------------------------------------------------------------
const GLYPH: Record<string, string> = {
  arrow_up_right: "↗", chevron_right: "›", chevron_left: "‹", chevron_down: "⌄", chevron_up: "⌃",
  plus: "+", minus: "−", check: "✓", play: "▶", captain: "C", plane: "✈", search: "⌕", globe: "◍", ticket: "▭",
};
function FosIcon({ node, parent }: { node: FlatNode; parent: Parent }) {
  const ctx = useCtx();
  const p = node.props;
  const size = num(p.size, ctx) ?? 16;
  return (
    <View style={[layout({ ...p, size: undefined }, parent, ctx), { width: size, height: size, alignItems: "center", justifyContent: "center" }]}>
      <RNText style={{ fontSize: size * 0.9, lineHeight: size, color: color(p.tone, ctx) ?? "#000" }}>{GLYPH[p.name] ?? "?"}</RNText>
    </View>
  );
}

function FosButton({ node, parent }: { node: FlatNode; parent: Parent }) {
  const ctx = useCtx();
  const p = node.props;
  const n = p._native ?? {};
  const t = typeOf(n.type, ctx);
  const ts: TextStyle = { ...textStyle(t, ctx), color: n.text ?? "#fff", textTransform: CASE[p.textCase] ?? "none" };
  return (
    <Pressable style={({ pressed }) => [
      layout(p, parent, ctx),
      {
        flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4,
        backgroundColor: pressed ? n.bgPressed ?? n.bg : n.bg, borderRadius: 8,
        borderWidth: n.border ? 1 : 0, borderColor: n.border,
        ...(p.block ? { alignSelf: "stretch" } : {}),
      },
    ]}>
      <RNText style={ts}>{String(p.label ?? "").trim()}</RNText>
      {p.iconEnd ? <RNText style={{ color: n.text ?? "#fff", fontSize: (t?.size ?? 12) * 1.1 }}>{GLYPH[p.iconEnd] ?? ""}</RNText> : null}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------------------------
export function Render({ page }: { page: Page }) {
  const value = useMemo<Ctx>(() => {
    const kids = new Map<string | null, FlatNode[]>();
    for (const n of page.nodes) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)!).push(n);
    for (const list of kids.values()) list.sort((a, b) => a.idx - b.idx);
    // The design is laid out at its own width, so its breakpoint is the design's, not the phone's.
    // Breakpoints key off the PAGE the design sits in, not this section's width (a 1170px section on a
    // 1366px page is desktop type) — the same mistake the web harness made once.
    const vp = page.viewport ?? page.width;
    const bp = vp >= 1280 ? "desktop" : vp >= 768 ? "tablet" : "mobile";
    return { page, kids, bp };
  }, [page]);
  const root = value.kids.get(null)?.[0];
  if (!root) return null;
  return (
    <PageCtx.Provider value={value}>
      <View style={{ width: page.width }}>
        <Node node={{ ...root, props: { ...root.props, place: undefined } }} parent={{ kind: "root" }} />
      </View>
    </PageCtx.Provider>
  );
}
