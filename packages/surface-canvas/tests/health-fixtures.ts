/**
 * Test fixtures. NO FIGMA — these run in plain node.
 *
 * Two things live here:
 *
 *   themeSnapshot()  the real Southern Brave theme, projected into a
 *                    ThemeSnapshot with a controllable bindability story. This
 *                    is the same normalization the plugin does; only the
 *                    Figma-variable half is faked.
 *
 *   node builders     small Frame IR nodes that carry exactly the slots a test
 *                    asks for, so a rule can be pointed at one value.
 */
import {
  formatNumber,
  normalizeTheme,
  rawThemeFileSchema,
  type Breakpoint,
  type NormalizedTheme,
} from "@fanos/tokens";
import rawTheme from "@fanos/tokens/fixtures/southern-brave.json";
import { colorFamily } from "../src/match/color.js";
import { DEFAULT_LINT_OPTIONS, type LintContext, type LintOptions, type ThemeSnapshot, type TokenBinding } from "../src/health/types.js";
import { IR_VERSION, type Effect, type Fill, type FrameIRDocument, type FrameIRNode, type IRNodeType, type Layout, type Stroke, type TextInfo, type TokenValue } from "../src/ir/schema.js";

export function theme(): NormalizedTheme {
  const parsed = rawThemeFileSchema.parse(rawTheme);
  const entries = Object.entries(parsed.tokens);
  const first = entries[0];
  if (!first) throw new Error("fixture theme has no themes");
  return normalizeTheme(first[0], first[1]);
}

export interface SnapshotOptions {
  /** Which token refs have a Figma variable behind them. Default: all of them. */
  bindable?: (ref: string) => boolean;
  /** Refs whose Figma variable exists but holds the wrong value. */
  mismatched?: Set<string>;
  orphans?: ThemeSnapshot["orphans"];
  localCollections?: number;
  libraryCollections?: number;
}

/** The reconciled snapshot, without a Figma file. */
export function themeSnapshot(options: SnapshotOptions = {}): ThemeSnapshot {
  const t = theme();
  const bindable = options.bindable ?? (() => true);
  const mismatched = options.mismatched ?? new Set<string>();
  let valueMismatches = 0;

  const bindingFor = (ref: string, raw: string, expected: string): TokenBinding | undefined => {
    if (!bindable(ref)) return undefined;
    if (mismatched.has(ref)) {
      valueMismatches++;
      return {
        medium: "variable",
        id: `var:${ref}`,
        figmaName: raw,
        figmaValue: expected,
        valueMatches: false,
      };
    }
    return { medium: "variable", id: `var:${ref}`, figmaName: raw, valueMatches: true };
  };

  const rawOf = (ref: string, category: Parameters<NormalizedTheme["names"]["toRaw"]>[1]) =>
    t.names.toRaw(ref, category) ?? ref.slice(ref.indexOf(".") + 1);

  const colors = [...t.color.light].map(([leaf, hex]) => {
    const ref = `color.${leaf}`;
    const raw = rawOf(ref, "color");
    const rgb: [number, number, number] = [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
    ];
    const binding = bindingFor(ref, raw, "#123456");
    return { ref, raw, hex, rgb, family: colorFamily(raw), ...(binding ? { binding } : {}) };
  });

  const numbers = (map: Map<string, number>, category: "space" | "radius") =>
    [...map].map(([leaf, px]) => {
      const ref = `${category}.${leaf}`;
      const raw = rawOf(ref, category);
      const binding = bindingFor(ref, raw, `${px + 4}px`);
      return { ref, raw, px, ...(binding ? { binding } : {}) };
    });

  const typeLeaves = new Set<string>();
  for (const bp of ["mobile", "tablet", "desktop"] as Breakpoint[]) {
    for (const leaf of t.type[bp].keys()) typeLeaves.add(leaf);
  }
  const types = [...typeLeaves].map((leaf) => {
    const ref = `type.${leaf}`;
    const raw = rawOf(ref, "type");
    const byBreakpoint: Record<string, unknown> = {};
    for (const bp of ["mobile", "tablet", "desktop"] as Breakpoint[]) {
      const style = t.type[bp].get(leaf);
      if (style) byBreakpoint[bp] = style;
    }
    const binding = bindable(ref)
      ? ({ medium: "textStyle", id: `style:${ref}`, figmaName: raw } as TokenBinding)
      : undefined;
    return {
      ref,
      raw,
      byBreakpoint: byBreakpoint as ThemeSnapshot["types"][number]["byBreakpoint"],
      ...(binding ? { binding } : {}),
    };
  });

  return {
    themeId: t.id,
    themeName: t.name,
    slug: t.slug,
    colors,
    spaces: numbers(t.space, "space"),
    radii: numbers(t.radius, "radius"),
    types,
    shadows: [...t.shadow.light].map(([leaf, shadow]) => {
      const ref = `shadow.${leaf}`;
      const raw = rawOf(ref, "shadow");
      // Shadows bind through an effect style, never a variable — Figma has no
      // composite shadow variable.
      const binding = bindable(ref)
        ? ({ medium: "effectStyle", id: `style:${ref}`, figmaName: raw } as TokenBinding)
        : undefined;
      return {
        ref,
        raw,
        value: `${shadow.inset ? "inset " : ""}${formatNumber(shadow.x)} ${formatNumber(shadow.y)} ${formatNumber(shadow.blur)} ${formatNumber(shadow.spread)} ${shadow.color}@${formatNumber(shadow.opacity)}%`,
        x: shadow.x,
        y: shadow.y,
        blur: shadow.blur,
        spread: shadow.spread,
        color: shadow.color,
        opacity: shadow.opacity,
        inset: shadow.inset,
        ...(binding ? { binding } : {}),
      };
    }),
    gradients: [...t.gradient.light].map(([leaf]) => {
      const ref = `gradient.${leaf}`;
      const raw = rawOf(ref, "gradient");
      const binding = bindingFor(ref, raw, "a different gradient");
      return { ref, raw, value: "linear 180deg", ...(binding ? { binding } : {}) };
    }),
    orphans: options.orphans ?? [],
    reconciled: true,
    localCollections: options.localCollections ?? 1,
    libraryCollections: options.libraryCollections ?? 0,
    valueMismatches,
  };
}

export function context(overrides: Partial<LintContext> = {}): LintContext {
  return {
    theme: overrides.theme ?? themeSnapshot(),
    breakpoint: overrides.breakpoint ?? "desktop",
    options: overrides.options ?? DEFAULT_LINT_OPTIONS,
  };
}

export function options(overrides: Partial<LintOptions> = {}): LintOptions {
  return { ...DEFAULT_LINT_OPTIONS, ...overrides };
}

// ---------------------------------------------------------------------------
// Frame IR builders
// ---------------------------------------------------------------------------

export interface NodeSpec {
  id?: string;
  name?: string;
  type?: IRNodeType;
  layoutMode?: "vertical" | "horizontal" | "none";
  positioning?: "auto" | "absolute";
  width?: number;
  height?: number;
  depth?: number;
  fill?: Fill | null;
  stroke?: Stroke | null;
  radius?: TokenValue | null;
  gap?: TokenValue | null;
  padding?: Partial<Record<"top" | "right" | "bottom" | "left", TokenValue>>;
  effects?: Effect[];
  text?: TextInfo;
  children?: FrameIRNode[];
}

let counter = 0;
export function resetIds(): void {
  counter = 0;
}

export function node(spec: NodeSpec = {}): FrameIRNode {
  counter += 1;
  const zero = (): TokenValue => ({ value: 0, unbound: false });
  const layout: Layout = {
    mode: spec.layoutMode ?? "none",
    gap: spec.gap ?? null,
    padding: {
      top: spec.padding?.top ?? zero(),
      right: spec.padding?.right ?? zero(),
      bottom: spec.padding?.bottom ?? zero(),
      left: spec.padding?.left ?? zero(),
    },
    align: null,
    justify: null,
    wrap: false,
    sizing: { w: "fixed", h: "fixed" },
    positioning: spec.positioning ?? "auto",
  };
  const w = spec.width ?? 100;
  const h = spec.height ?? 50;
  const children = spec.children ?? [];

  const out: FrameIRNode = {
    id: spec.id ?? `n:${counter}`,
    name: spec.name ?? `Layer ${counter}`,
    type: spec.type ?? "FRAME",
    layout,
    geometry: {
      bbox: { x: 0, y: 0, w, h },
      relBbox: { x: 0, y: 0, w, h },
      aspect: h > 0 ? w / h : 0,
      aspectBucket: "landscape",
    },
    fill: spec.fill ?? null,
    stroke: spec.stroke ?? null,
    radius: spec.radius ?? null,
    effects: spec.effects ?? [],
    opacity: 1,
    clipsContent: false,
    structuralSignature: "sig",
    canonicalSignature: "canon",
    repeatedSiblings: 1,
    depth: spec.depth ?? 0,
    childCount: children.length,
    children,
  };
  if (spec.text) out.text = spec.text;
  return out;
}

export function document(root: FrameIRNode, overrides: Partial<FrameIRDocument> = {}): FrameIRDocument {
  return {
    fileKey: null,
    fileName: "Southern Brave",
    pageName: "Home",
    rootNodeId: root.id,
    extractedAt: "2026-08-10T00:00:00.000Z",
    irVersion: IR_VERSION,
    breakpointHint: root.geometry.bbox.w,
    root,
    ...overrides,
  };
}

/** Assigns `depth` down the tree, the way traversal would have. */
export function withDepths(root: FrameIRNode, depth = 0): FrameIRNode {
  root.depth = depth;
  root.childCount = root.children.length;
  for (const child of root.children) withDepths(child, depth + 1);
  return root;
}

// --- slot shorthands -------------------------------------------------------

export function looseFill(raw: string): Fill {
  return { raw, unbound: true };
}

export function boundFill(tokenRef = "color.core_neu_00"): Fill {
  return { tokenRef, unbound: false };
}

export function looseStroke(raw: string, weight = 1): Stroke {
  return { raw, weight, unbound: true };
}

export function boundStroke(tokenRef = "color.core_neu_300", weight = 1): Stroke {
  return { tokenRef, weight, unbound: false };
}

export function loose(value: number): TokenValue {
  return { value, unbound: value !== 0 };
}

export function bound(value: number, tokenRef = "space.4"): TokenValue {
  return { value, tokenRef, unbound: false };
}

export function looseEffect(type = "DROP_SHADOW", geo?: Partial<Omit<Effect, "type" | "unbound">>): Effect {
  return { type, unbound: true, ...geo };
}

export function boundEffect(type = "DROP_SHADOW"): Effect {
  return { type, styleId: "S:1", styleRef: "drop_shadow_md", unbound: false };
}

export function looseText(over: Partial<TextInfo> = {}): TextInfo {
  return {
    characters: "Hello",
    unbound: true,
    fontSize: 20,
    fontFamily: "Montserrat",
    fontWeight: 700,
    lineHeight: 28,
    autoResize: "NONE",
    lines: 1,
    ...over,
  };
}

export function boundText(over: Partial<TextInfo> = {}): TextInfo {
  return { ...looseText(), unbound: false, styleId: "S:2", styleRef: "h1_bold", ...over };
}

/** A linear gradient in the exact form the extractor writes. */
export function gradient(from: string, to: string): string {
  return `GRADIENT_LINEAR(${from} 0%, ${to} 100%; m=[1,0,0,0,1,0])`;
}
