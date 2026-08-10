/**
 * IR fields -> DSL props.
 *
 * Every mapping here is a straight read. The interesting judgement is in what
 * NOT to write: a value that Figma already expresses as intrinsic sizing must
 * not become a pixel, and a value that is bound to a variable must not become
 * a raw. Those two rules are the difference between a tree that survives a
 * different viewport and one pinned to the width it was exported at.
 */

import type { FrameIRNode, Layout, TokenValue } from "@fanos/figma-ir-extractor/ir";
import type { NormalizedTheme } from "@fanos/tokens";
import { canonicalRef } from "./refs.js";

export type Raw = { raw: number; _unbound: true };
export const raw = (n: number): Raw => ({ raw: round(n), _unbound: true });

/** Four decimals is past sub-pixel; more just makes trees noisy to diff. */
export function round(n: number): number {
  return Number(n.toFixed(4));
}

/**
 * A length: the token if Figma bound one, the number if it did not.
 *
 * `unbound` in the IR means "a real value with no variable behind it", which is
 * exactly a `Raw`. A zero with no binding is simply absent — writing `0` for
 * every unset padding would triple the size of every tree.
 */
export function length(
  theme: NormalizedTheme,
  v: TokenValue | null | undefined,
): string | Raw | undefined {
  if (!v) return undefined;
  const ref = canonicalRef(theme, v.tokenRef, "space");
  if (ref) return ref;
  if (v.value === 0) return undefined;
  // Figma says unbound, but the number IS a scale step — the designer typed 28
  // where `space.7` was available. Binding it is not a guess: the value is
  // identical, and a raw here would re-theme wrongly the moment the scale moves.
  return snapSpace(theme, v.value) ?? raw(v.value);
}

/** The space token whose px value is exactly `n`, if there is one. */
export function snapSpace(theme: NormalizedTheme, n: number): string | undefined {
  for (const [leaf, px] of theme.space) if (Math.abs(px - n) < 0.01) return `space.${leaf}`;
  return undefined;
}

const ALIGN: Record<string, string> = {
  MIN: "start",
  CENTER: "center",
  MAX: "end",
  BASELINE: "baseline",
  STRETCH: "stretch",
};

const JUSTIFY: Record<string, string> = {
  MIN: "start",
  CENTER: "center",
  MAX: "end",
  SPACE_BETWEEN: "between",
};

export interface SpaceProps {
  p?: string | Raw;
  px?: string | Raw;
  py?: string | Raw;
  pt?: string | Raw;
  pr?: string | Raw;
  pb?: string | Raw;
  pl?: string | Raw;
}

/**
 * Padding, collapsed to the shortest honest form.
 *
 * Figma always reports four sides. Writing all four when they are equal is
 * noise, and `p` / `px` / `py` are the vocabulary designers actually use — so
 * collapse when the values are identical, and only then.
 */
export function space(theme: NormalizedTheme, layout: Layout): SpaceProps | undefined {
  const t = length(theme, layout.padding.top);
  const r = length(theme, layout.padding.right);
  const b = length(theme, layout.padding.bottom);
  const l = length(theme, layout.padding.left);
  if (t === undefined && r === undefined && b === undefined && l === undefined) return undefined;

  const same = (a: unknown, c: unknown) => JSON.stringify(a) === JSON.stringify(c);
  if (same(t, r) && same(r, b) && same(b, l)) return { p: t! };

  const out: SpaceProps = {};
  if (same(t, b) && t !== undefined) out.py = t;
  else {
    if (t !== undefined) out.pt = t;
    if (b !== undefined) out.pb = b;
  }
  if (same(l, r) && l !== undefined) out.px = l;
  else {
    if (l !== undefined) out.pl = l;
    if (r !== undefined) out.pr = r;
  }
  return out;
}

export interface SizeProps {
  w?: string | Raw;
  h?: string | Raw;
  ratio?: string;
}

/**
 * Size, from `layout.sizing` FIRST and the bbox only as a last resort.
 *
 * This is the rule that keeps a tree responsive. Figma's hug/fill is the
 * intrinsic-sizing contract and maps straight onto CSS; reading the bbox
 * instead pins the node to the one width the frame was exported at. An audit
 * of five hand-written trees found 9 of 44 raw sizes contradicting the IR this
 * way, every one of them avoidable.
 */
export function size(n: FrameIRNode, isRoot: boolean): SizeProps | undefined {
  const out: SizeProps = {};
  const { w, h } = n.layout.sizing;
  const box = n.geometry.relBbox;

  /**
   * The root defines the frame, so its WIDTH is its box — there is nothing
   * inside this export for it to hug or fill against.
   *
   * Height is different: `hug` still means "as tall as the content", and that
   * is reproducible. Pinning it would freeze the frame at whatever the text
   * happened to wrap to on export day.
   */
  if (isRoot) {
    out.w = raw(box.w);
    out.h = h === "hug" ? "auto" : raw(box.h);
    return out;
  }

  if (w === "hug") out.w = "auto";
  else if (w === "fill") out.w = "full";
  else out.w = raw(box.w);

  if (h === "hug") out.h = "auto";
  else if (h === "fill") out.h = "full";
  else out.h = raw(box.h);

  return out;
}

export interface PlaceProps {
  anchor: string;
  offset?: { block?: Raw; inline?: Raw };
}

/**
 * Absolute placement, always from the top-left.
 *
 * `relBbox` is measured from the parent's top-left, so `top-start` plus the raw
 * offsets is an exact transcription. Picking a "nicer" anchor — mid, end —
 * would mean inferring intent the IR does not record, and getting it wrong
 * moves the node.
 */
export function place(n: FrameIRNode): PlaceProps {
  const { x, y } = n.geometry.relBbox;
  const offset: PlaceProps["offset"] = {};
  if (Math.abs(y) > 0.001) offset.block = raw(y);
  if (Math.abs(x) > 0.001) offset.inline = raw(x);
  return Object.keys(offset).length > 0 ? { anchor: "top-start", offset } : { anchor: "top-start" };
}

export interface StackProps {
  direction?: "row" | "column";
  gap?: string | Raw;
  align?: string;
  justify?: string;
  wrap?: boolean;
}

export function stack(theme: NormalizedTheme, layout: Layout): StackProps {
  const out: StackProps = {};
  // Column is the DSL default, so writing it adds nothing.
  if (layout.mode === "horizontal") out.direction = "row";
  const gap = length(theme, layout.gap);
  if (gap !== undefined) out.gap = gap;
  if (layout.align && ALIGN[layout.align]) out.align = ALIGN[layout.align];
  if (layout.justify && JUSTIFY[layout.justify]) out.justify = JUSTIFY[layout.justify];
  if (layout.wrap) out.wrap = true;
  return out;
}

export interface TextProps {
  content: string;
  style: string;
  tone?: string;
  truncate?: number;
}

/**
 * @returns undefined when the text style cannot be resolved — a Text with no
 *          `style` is invalid, so the caller reports it rather than emitting
 *          a tree that fails its own schema.
 */
export function text(theme: NormalizedTheme, n: FrameIRNode): TextProps | undefined {
  if (!n.text) return undefined;
  const style = canonicalRef(theme, n.text.styleRef, "type");
  if (!style) return undefined;
  const out: TextProps = { content: n.text.characters, style };
  const tone = canonicalRef(theme, n.fill?.tokenRef, "color");
  if (tone) out.tone = tone;
  // Figma's TRUNCATE is a line clamp, and `lines` is the count it clamps at.
  if (n.text.autoResize === "TRUNCATE" && n.text.lines > 0) out.truncate = n.text.lines;
  return out;
}
