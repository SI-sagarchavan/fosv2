/**
 * IR fields -> DSL props.
 *
 * Every mapping here is a straight read. The interesting judgement is in what
 * NOT to write: a value that Figma already expresses as intrinsic sizing must
 * not become a pixel, and a value that is bound to a variable must not become
 * a raw. Those two rules are the difference between a tree that survives a
 * different viewport and one pinned to the width it was exported at.
 */

import type { FrameIRNode, Layout, TokenValue } from "@fanos/surface-canvas/ir";
import { DEFAULT_BREAKPOINTS, type Breakpoints, type NormalizedTheme } from "@fanos/tokens";
import { canonicalRef } from "./refs.js";
import { flowChildren } from "./classify.js";
import { layoutBox } from "./geometry.js";
import { isMeaningful, slug } from "./ids.js";

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
 * A root frame that is the page's full width, rather than an object drawn on it.
 *
 * The distinction decides whether the root's width is a fact about the design
 * or an accident of the artboard. A 281px player card is 281px wide wherever it
 * lands; a 1366px live strip is 1366 only because that is the artboard the
 * designer drew it on, and shipping it pinned leaves a white gutter on every
 * wider desktop.
 *
 * `breakpoints.lg` is the same threshold `inferBreakpoint` uses to decide a
 * frame is a desktop design in the first place, so the two cannot disagree
 * about what "desktop-wide" means. The IR's `breakpointHint` is NOT usable
 * here: the plugin sets it from this very box, so it agrees by construction.
 *
 * Deliberately width-only. A tall frame is not a band, and nothing about a
 * design's vertical extent is an artboard artefact in the same way.
 */
export function isBand(n: FrameIRNode, breakpoints: Breakpoints = DEFAULT_BREAKPOINTS): boolean {
  return layoutBox(n).w >= breakpoints.lg;
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
export function size(n: FrameIRNode, isRoot: boolean, band = false): SizeProps | undefined {
  const out: SizeProps = {};
  const { w, h } = n.layout.sizing;
  const box = layoutBox(n);

  /**
   * The root defines the frame, so its WIDTH is its box — there is nothing
   * inside this export for it to hug or fill against. Unless it is a BAND, and
   * then the page is what it fills: see `isBand`.
   *
   * Height is different: `hug` still means "as tall as the content", and that
   * is reproducible. Pinning it would freeze the frame at whatever the text
   * happened to wrap to on export day.
   */
  if (isRoot) {
    out.w = band ? "full" : raw(box.w);
    out.h = h === "hug" ? "auto" : raw(box.h);
    return out;
  }

  const pin = unhuggableAxes(n);

  if (w === "hug") out.w = pin.w ? raw(box.w) : "auto";
  else if (w === "fill") out.w = "full";
  else out.w = raw(box.w);

  if (h === "hug") out.h = pin.h ? raw(box.h) : "auto";
  else if (h === "fill") out.h = "full";
  else out.h = raw(box.h);

  return out;
}

/**
 * Axes where `hug` cannot be reproduced, so the box has to be pinned.
 *
 * Figma and CSS disagree about one thing here, and it is not a rounding
 * difference. A Figma frame set to hug still resolves to a concrete box around
 * absolutely-positioned children. In CSS those children are out of flow and
 * contribute NOTHING to intrinsic size, so `width: auto` collapses — measured
 * on the fixtures page, a 333px overlay of three placed buttons came out 72px,
 * and every descendant inherited the 262px shift.
 *
 * So: hug is only reproducible when something is in flow to hug. When nothing
 * is, the IR's own box is the only honest answer.
 *
 * Narrow deliberately, because pinning costs responsiveness — the doc on
 * `size` is right that a raw px freezes the node at export width:
 *
 *   - per axis, since a node can hug one and fix the other;
 *   - only when the flow is EMPTY. A node with even one in-flow child hugs it,
 *     and Figma ignores absolute children for hug sizing too, so the two agree;
 *   - only for nodes that have children at all. A childless hug resolves to
 *     padding in both systems.
 *
 * Type-agnostic on purpose. This is about flow, not about `Overlay`: an
 * auto-layout Stack whose children are all absolute fails in exactly the same
 * way, and would be missed by a rule that keyed off the node type.
 */
export function unhuggableAxes(n: FrameIRNode): { w: boolean; h: boolean } {
  if ((n.children ?? []).length === 0) return { w: false, h: false };
  if (flowChildren(n).length > 0) return { w: false, h: false };

  const { w, h } = n.layout.sizing;
  return { w: w === "hug", h: h === "hug" };
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

/**
 * How much of a fluid parent an absolute child must cover to read as its
 * content row rather than as something positioned inside it.
 *
 * 0.9 is loose on purpose. The live strip's row covers 95.5% of the band —
 * 41.7px of margin on one side, 20.3 on the other — and asymmetric margins like
 * that are the norm, not a mistake. Anything under nine tenths is a badge, a
 * logo or a cutout, and moving one of those to the edge would be a real
 * relayout rather than a de-pinning.
 */
const SPAN_RATIO = 0.9;

/** Sub-pixel slack. Figma reports instance geometry to four decimals. */
const TOL = 0.01;

export interface InlineStretch {
  /**
   * Where the content starts and ends once the box itself spans the parent:
   * the gap the design left outside the box PLUS the padding it had inside it.
   * Undefined for an edge with neither, so a node keeps its own bound padding.
   */
  pl?: string | Raw;
  pr?: string | Raw;
}

/**
 * An absolutely-placed child that spans its parent, re-expressed as a stretch.
 *
 * A Figma frame with no auto-layout gives every child a position and a size,
 * and transcribing that literally is correct at exactly one width. The moment
 * the parent is fluid — a band fills the page — a child pinned to `x: 41.7,
 * w: 1303.9` tears away from the right edge and leaves a widening gap of bare
 * background, which is exactly what the live strip did at anything wider than
 * the artboard.
 *
 * So: when the child covers the parent, its left and right gaps become padding
 * and the box itself stretches (`top-fill`). At the design width this is the
 * same rectangle to the pixel — the padding IS the old offset and the old
 * margin — and at every other width it is the one the designer would have drawn.
 *
 * Inline only. The block axis keeps its anchor and its offset, because a band's
 * height is a design constant and stretching it would make every sibling in a
 * tall frame overlap.
 *
 * @returns null when the child does not span the parent, and should stay where
 *          the IR put it.
 */
export function inlineStretch(
  theme: NormalizedTheme,
  n: FrameIRNode,
  parent: FrameIRNode,
): InlineStretch | null {
  const parentW = layoutBox(parent).w;
  const box = layoutBox(n);
  if (parentW <= 0 || box.w / parentW < SPAN_RATIO) return null;

  const left = box.x;
  const right = parentW - box.x - box.w;
  // A child that hangs outside its parent is a bleed, not a content row, and
  // negative padding does not mean what a negative offset means.
  if (left < -TOL || right < -TOL) return null;

  const out: InlineStretch = {};
  const pl = gapLength(theme, left, n.layout.padding.left.value);
  const pr = gapLength(theme, right, n.layout.padding.right.value);
  if (pl !== undefined) out.pl = pl;
  if (pr !== undefined) out.pr = pr;
  return out;
}

/**
 * One edge's total inset as a length: the token if one matches exactly, else a
 * raw. Undefined when there is nothing to say, which leaves the node's own
 * padding — and its binding — alone.
 */
function gapLength(
  theme: NormalizedTheme,
  gap: number,
  ownPadding: number,
): string | Raw | undefined {
  if (gap <= TOL) return undefined;
  const total = gap + ownPadding;
  return snapSpace(theme, total) ?? raw(total);
}

/**
 * True when a row's children reach both its edges.
 *
 * The question `justify` cannot answer on its own. Figma reports MIN for a row
 * whose children happen to fill it exactly, because with no free space to
 * distribute, "packed at the start" and "spread across" are the same picture.
 * They stop being the same picture the moment the row is fluid, and only one of
 * them is what the design shows — a live strip's call to action belongs at the
 * right edge, not floating three hundred pixels short of it.
 *
 * Measured against the in-flow children only, and against the row's padding
 * box, so a row that really does leave a deliberate gap on the right keeps it.
 */
export function childrenFillRow(n: FrameIRNode): boolean {
  const kids = flowChildren(n);
  if (kids.length < 2) return false;

  const box = layoutBox(n);
  const padLeft = n.layout.padding.left.value;
  const padRight = n.layout.padding.right.value;
  const content = box.w - padLeft - padRight;
  if (content <= 0) return false;

  let last = 0;
  for (const kid of kids) {
    const k = layoutBox(kid);
    last = Math.max(last, k.x + k.w - padLeft);
  }
  // 1% of the row, and never less than the sub-pixel noise a fill leaves behind.
  return content - last <= Math.max(4, content * 0.01);
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

export interface ButtonProps {
  label: string;
  variant: string;
  styleN: number;
  size: string;
  iconStart?: string;
  iconEnd?: string;
  action: { kind: "none" };
  space?: SpaceProps;
}

/**
 * The frame that actually carries the button's box.
 *
 * A component instance is usually a wrapper around the master, and the padding,
 * gap and children live on the inner one — `atom_button` holds nothing but
 * `atom_button_master`, which holds the label and the arrow. Reading the outer
 * frame gives a button with no padding and no label. Same descent as
 * `iconNameSource`, for the same reason.
 */
function buttonBody(n: FrameIRNode): FrameIRNode {
  let cursor = n;
  while ((cursor.children ?? []).length === 1) {
    const only = cursor.children![0]!;
    if (only.text !== undefined || (only.children ?? []).length === 0) break;
    cursor = only;
  }
  return cursor;
}

/** The first text anywhere under `n` — a button has exactly one label. */
function firstText(n: FrameIRNode): FrameIRNode | undefined {
  if (n.text !== undefined) return n;
  for (const c of n.children ?? []) {
    const hit = firstText(c);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * `color.button_outline_style_2_text_default` -> outline / 2.
 *
 * The token binding is where the VARIANT lives, and it has to be, because a
 * name cannot carry it: encode it as `atom_button_outline_2` and the name lies
 * the moment a designer switches one instance to filled. Figma re-points the
 * binding on that instance; it does not rename the layer.
 */
function buttonFamily(ref: string | undefined): { variant: string; styleN: number } | undefined {
  if (!ref) return undefined;
  const m = /button_(.+?)_style_(\d)_/.exec(ref);
  if (!m) return undefined;
  // The DSL spells the variant with a hyphen; the token name uses underscores.
  return { variant: m[1]!.replace(/_/g, "-"), styleN: Number(m[2]) };
}

/** `atom_icon_arrow_up_right` -> `arrow_up_right`. The prefix is the marker, not the glyph. */
function iconRef(name: string): string {
  return slug(name).replace(/^(?:atom_)?icons?_/, "");
}

/**
 * A declared Button's props, read from the instance the designer marked.
 *
 * Everything here is a read, not a guess — which is what makes it safe to run
 * deterministically once the component itself has been declared:
 *
 *   label     the one text under it
 *   variant   the `button_<variant>_style_<n>` family its paint is bound to
 *   size      the `type.button_<size>` its label is bound to
 *   icons     glyph layers before and after the label, in flow order
 *   space     the padding Figma reports, so the box is the drawn box
 *
 * `action` is NOT derived. Where a button goes is not in the design, and
 * inventing a href is the same class of mistake as inventing a data model.
 * It comes out as `none` for the binding step to fill in.
 */
export function button(theme: NormalizedTheme, n: FrameIRNode): ButtonProps | undefined {
  const body = buttonBody(n);
  const text = firstText(body);
  if (!text?.text) return undefined;

  const family =
    buttonFamily(canonicalRef(theme, text.fill?.tokenRef, "color")) ??
    buttonFamily(canonicalRef(theme, body.fill?.tokenRef, "color")) ??
    buttonFamily(canonicalRef(theme, body.stroke?.tokenRef, "color")) ??
    buttonFamily(canonicalRef(theme, n.fill?.tokenRef, "color"));

  const typeRef = canonicalRef(theme, text.text.styleRef, "type");
  const size = /^type\.button_(sm|md|lg)$/.exec(typeRef ?? "")?.[1];

  const out: ButtonProps = {
    label: text.text.characters,
    variant: family?.variant ?? "filled",
    styleN: family?.styleN ?? 1,
    size: size ?? "md",
    action: { kind: "none" },
  };

  // Glyphs either side of the label, in the order Figma flows them.
  const kids = flowChildren(body);
  const labelAt = kids.findIndex((c) => firstText(c) !== undefined);
  for (const [i, kid] of kids.entries()) {
    if (i === labelAt || firstText(kid) !== undefined) continue;
    if (!isMeaningful(kid.name)) continue;
    if (i < labelAt || labelAt === -1) out.iconStart ??= iconRef(kid.name);
    else out.iconEnd ??= iconRef(kid.name);
  }

  const padding = space(theme, body.layout);
  if (padding) out.space = padding;

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
  const clamp = truncateLines(n);
  if (clamp !== undefined) out.truncate = clamp;
  return out;
}

/**
 * The line clamp, from whichever way Figma expressed it.
 *
 * Two ways, and only the first is current. `textTruncation: ENDING` is what a
 * designer sets today, and it is independent of `autoResize` — a clamped
 * auto-height layer reports `HEIGHT` like an unclamped one, which is why this
 * used to be missed entirely. `autoResize: TRUNCATE` is the older mode, still
 * present in exported corpus rows, so both are honoured.
 *
 * `maxLines` is preferred when Figma pinned one; without it, `lines` is the
 * count the box itself implies, which is the same number for a layer whose
 * height Figma derived from the clamp.
 *
 * Nothing is inferred from geometry alone. A text whose content overflows its
 * box looks identical to one the designer meant to flow, and guessing would put
 * a permanent clamp on every paragraph in every design.
 */
function truncateLines(n: FrameIRNode): number | undefined {
  const text = n.text;
  if (!text) return undefined;

  if (text.truncation === "ENDING") {
    const max = text.maxLines;
    if (typeof max === "number" && max > 0) return max;
    return text.lines > 0 ? text.lines : undefined;
  }
  if (text.autoResize === "TRUNCATE" && text.lines > 0) return text.lines;
  return undefined;
}
