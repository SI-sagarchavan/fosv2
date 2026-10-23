/**
 * IR fields -> DSL props.
 *
 * Every mapping here is a straight read. The interesting judgement is in what
 * NOT to write: a value that Figma already expresses as intrinsic sizing must
 * not become a pixel, and a value that is bound to a variable must not become
 * a raw. Those two rules are the difference between a tree that survives a
 * different viewport and one pinned to the width it was exported at.
 */

import type {
  FrameIRNode,
  Layout,
  TextCaseValue,
  TokenValue,
} from "@fanos/surface-canvas/ir";
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
export function size(
  n: FrameIRNode,
  isRoot: boolean,
  band = false,
  placed = false,
): SizeProps | undefined {
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

  /**
   * `fill` means nothing on a node nothing is flowing.
   *
   * Figma keeps reporting `sizing: fill` on a child it has taken OUT of the
   * layout — an absolutely-positioned child, or any child of a frame with no
   * auto-layout at all. There is no parent axis left to fill, and the box the
   * designer drew is the only statement about size in play. Believing the flag
   * turns it into `width: 100%` of a parent it was never measured against.
   *
   * That is what collapsed the followed-players grid: four 347px rows placed
   * two-up inside a 710px frame each came out `w: "full"`, so all four went
   * full width, the grid lost a column and 104px of height, and everything
   * below it — consent line, SAVE bar — rode up into the rows.
   *
   * `hug` is left alone. A placed node's content still flows inside it, so hug
   * is reproducible for the same reasons `unhuggableAxes` already sets out.
   */
  const fillIsMeaningless = placed;

  if (w === "hug") out.w = pin.w ? raw(box.w) : "auto";
  else if (w === "fill" && !fillIsMeaningless) out.w = "full";
  else out.w = raw(box.w);

  if (h === "hug") out.h = pin.h ? raw(box.h) : "auto";
  else if (h === "fill" && !fillIsMeaningless) out.h = "full";
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
  if (!nothingFlows(n)) return { w: false, h: false };

  const { w, h } = n.layout.sizing;
  return { w: w === "hug", h: h === "hug" };
}

/**
 * Is there anything inside this node for CSS to size against?
 *
 * Two ways to have nothing, and only one of them was being checked.
 *
 *   - every child is marked `positioning: absolute`. That is `flowChildren`,
 *     and it covers an auto-layout frame with placed children.
 *   - the node has NO auto-layout. Figma then reports each child as `auto`
 *     positioned — there is no layout for them to be an exception to — but
 *     nothing flows them either: their box IS their position, which is why
 *     `emit` gives every child of an Overlay a `place`. Reading `positioning`
 *     alone therefore said "these children are in flow" about children the
 *     compiler was about to take out of flow.
 *
 * The consequence was a hug that collapsed. The followed-players grid is a
 * 710x116 frame with no auto-layout holding four placed rows; it compiled to
 * `h: "auto"`, rendered 0px tall, and pulled the consent line and the SAVE bar
 * up into the rows above them. This condition and the one `emit` uses to write
 * `place` have to be the same condition, or one of them is wrong.
 */
function nothingFlows(n: FrameIRNode): boolean {
  return n.layout.mode === "none" || flowChildren(n).length === 0;
}

export interface PlaceProps {
  anchor: string;
  offset?: { block?: Raw; inline?: Raw };
}

/**
 * Absolute placement, always from the top-left.
 *
 * `top-start` plus a raw offset is an exact transcription. Picking a "nicer"
 * anchor — mid, end — would mean inferring intent the IR does not record, and
 * getting it wrong moves the node.
 *
 * The offset comes from `bbox`, not `relBbox`, and that is the whole substance
 * of this function. `relBbox` carries Figma's `node.x`/`node.y`, which are NOT
 * the node's offset inside its parent in two common cases:
 *
 *   1. **Inside a GROUP.** A group is not a coordinate space. Figma reports its
 *      children in the space of the group's own parent, so a group at x=16
 *      holding a child reported at x=28.36 does not hold that child 28.36px
 *      from its own left edge — it is 12.36px in. Transcribing the number adds
 *      the group's origin a second time, once per level of nesting. Measured on
 *      the fan-preferences frame: every player photo sat 12px right of its
 *      plate, and a header texture landed 77px off.
 *
 *   2. **On a rotated node.** `node.x`/`node.y` is the transform origin, which
 *      for a half-turn is the box's BOTTOM-RIGHT. One of the two header
 *      textures is rotated 180°, and its reported x was a full box-width — 763px
 *      — past where the design puts it: the largest single deviation in the file.
 *
 * `bbox` has neither problem. It is `absoluteBoundingBox`: page coordinates,
 * axis-aligned, already post-rotation. The difference between a node's and its
 * parent's is the offset CSS wants, for groups, rotations and ordinary frames
 * alike — and it is the same quantity `@fanos/conform` derives the expected box
 * from, so the compiler and the gate can no longer disagree about where a node
 * belongs.
 *
 * `relBbox` remains the fallback for a node with no parent to measure against.
 *
 * @param parent the node this one is placed inside, when there is one. Omit it
 *               only where none exists, never to save a lookup: absent means
 *               "fall back to relBbox", which is the behaviour being fixed.
 */
export function place(n: FrameIRNode, parent?: FrameIRNode): PlaceProps {
  const { x, y } = parentRelative(n, parent);
  const offset: PlaceProps["offset"] = {};
  if (Math.abs(y) > 0.001) offset.block = raw(y);
  if (Math.abs(x) > 0.001) offset.inline = raw(x);
  return Object.keys(offset).length > 0 ? { anchor: "top-start", offset } : { anchor: "top-start" };
}

/**
 * Where a node's painted box starts inside its parent's. See {@link place}.
 *
 * Matched on CENTRES rather than corners, which matters for exactly one case
 * and is identical everywhere else. `bbox` is the axis-aligned envelope AFTER
 * rotation while `layoutBox` is the rectangle this compiler can actually emit;
 * for an upright node, a half turn and a quarter turn those are the same size,
 * so corner and centre agree to the pixel. For an arbitrary angle they do not:
 * the header's 34.8°-rotated gradient plate has a 1068x1172 envelope around a
 * 596x1013 box, and pinning the small rectangle to the big envelope's corner
 * throws it 200px up and left of the artwork it stands in for.
 *
 * The rectangle is an approximation either way — the IR carries no path data,
 * so a rotated plate becomes an upright one; see `isDecorativeVector`. Centring
 * it is the approximation that stays where the design's mass is.
 */
function parentRelative(n: FrameIRNode, parent?: FrameIRNode): { x: number; y: number } {
  if (!parent) return { x: n.geometry.relBbox.x, y: n.geometry.relBbox.y };

  const box = layoutBox(n);
  const env = n.geometry.bbox;
  return {
    x: env.x - parent.geometry.bbox.x + (env.w - box.w) / 2,
    y: env.y - parent.geometry.bbox.y + (env.h - box.h) / 2,
  };
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

/**
 * Distribution modes where Figma IGNORES `itemSpacing`.
 *
 * Figma disables the spacing field the moment auto-layout is set to distribute:
 * the children go edge to edge and whatever number was last in the box is
 * leftover state, not a gap. CSS does not agree — `gap` is a floor and
 * `justify-content` distributes what is left AFTER it — so emitting both counts
 * the spacing twice.
 *
 * Measured on the points table, whose header row is 800px wide with six columns
 * summing to 488 and a stale `itemSpacing` of 113. Emitting both put five 113px
 * gaps into an 800px row: 1053px of content, 253px of overflow, and the FORM
 * and PTS columns pushed off the page.
 */
const DISTRIBUTES = new Set(["between", "around", "evenly"]);

export function stack(theme: NormalizedTheme, layout: Layout): StackProps {
  const out: StackProps = {};
  // Column is the DSL default, so writing it adds nothing.
  if (layout.mode === "horizontal") out.direction = "row";
  const justify = layout.justify ? JUSTIFY[layout.justify] : undefined;
  const gap = length(theme, layout.gap);
  if (gap !== undefined && !(justify && DISTRIBUTES.has(justify))) out.gap = gap;
  if (layout.align && ALIGN[layout.align]) out.align = ALIGN[layout.align];
  if (justify) out.justify = justify;
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
  block?: boolean;
  textCase?: "none" | "upper" | "lower" | "title";
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
/**
 * A layer name, normalised to the registry's naming.
 *
 * `Atom_Icon_Chevron_Left` -> `chevron_left`. The `atom_`/`icon_` prefixes are
 * a Figma organisational convention, not part of the glyph's identity, and a
 * name that keeps them misses a registry that does not.
 */
export function iconRef(name: string): string {
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

  /**
   * The SURFACE decides, then the border, then the label.
   *
   * Designers mix families inside one button: the Southern Brave hospitality
   * cards bind a `filled/style_1` red surface, an `outline/style_1` border and an
   * `outline/style_3` white label. What the eye sees is a red filled button, and
   * reading the label first called it outline/3 — white on transparent, invisible
   * on a white card. An outline button has no surface, so its border speaks next;
   * a link has neither, so the label is the last word, not the first.
   */
  const family =
    buttonFamily(canonicalRef(theme, body.fill?.tokenRef, "color")) ??
    buttonFamily(canonicalRef(theme, n.fill?.tokenRef, "color")) ??
    buttonFamily(canonicalRef(theme, body.stroke?.tokenRef, "color")) ??
    buttonFamily(canonicalRef(theme, text.fill?.tokenRef, "color"));

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

  /**
   * A button Figma sets to fill its row is a full-width button.
   *
   * Read off the OUTER node rather than the body: the instance is what the
   * layout sizes, and the master inside it hugs regardless. This is the one
   * piece of `size` a Button can carry — see `Button.block` in @fanos/dsl for
   * why the universal size object cannot say it — and without it every form's
   * primary action compiled to a pill the width of its label.
   */
  if (n.layout.sizing.w === "fill") out.block = true;

  // The label layer's own case setting — see `Text` below, and `Button.textCase`
  // in @fanos/dsl. Read from the layer the label came from, not from the
  // instance, because that is where Figma records it.
  if (text.text.textCase) out.textCase = TEXT_CASE[text.text.textCase];

  return out;
}

export interface TextProps {
  content: string;
  style: string;
  tone?: string;
  truncate?: number;
  textCase?: "none" | "upper" | "lower" | "title";
  trim?: "none";
  wrap?: false;
}

/**
 * The type token whose four properties are the ones this layer actually has.
 *
 * Figma splits a text style across several variables — `typeface/body`,
 * `size/body_sm`, a weight — so a layer can be fully bound in Figma and still
 * report a `styleRef` that names none of the theme's composite type tokens.
 * `size/body_sm` is not `type.body_sm_regular`; it is one third of it.
 *
 * The name cannot be repaired, but the VALUES can be read: family, size,
 * weight and line height are all in the IR, and a theme type token is exactly
 * those four numbers. So when the name misses, the quadruple is matched
 * against the theme directly.
 *
 * Exact only, and deliberately so — see `matchType` in the plugin, which is
 * the same rule for the same reason. A 15/22 Medium is not "nearly" `body_md`
 * at 16/24, it is a fifth style nobody declared, and rounding it in would put
 * a value in the tree that the design does not contain.
 *
 * Desktop first because that is the breakpoint a 1366px frame was drawn at;
 * the others are tried after so a mobile-only style still lands.
 */
function matchTypeToken(theme: NormalizedTheme, n: FrameIRNode): string | undefined {
  const t = n.text;
  if (!t || t.lineHeight === "auto") return undefined;

  const weight = resolveWeight(t.fontWeight);
  if (weight === undefined) return undefined;
  const family = t.fontFamily.trim().toLowerCase();
  if (family.length === 0) return undefined;

  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 0.5;

  for (const bp of ["desktop", "tablet", "mobile"] as const) {
    const hits: string[] = [];
    for (const [leaf, style] of theme.type[bp]) {
      if (
        style.family.trim().toLowerCase() === family &&
        near(style.size, t.fontSize) &&
        style.weight === weight &&
        near(style.lineHeight, t.lineHeight)
      ) {
        hits.push(leaf);
      }
    }
    // Shortest name, then alphabetical: deterministic, and the shortest name is
    // the least qualified one, which is the family's base style.
    const winner = hits.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))[0];
    if (winner) return `type.${winner}`;
  }
  return undefined;
}

/**
 * Figma stores weight as a face name (`Bold`); the theme is always numeric.
 *
 * Duplicated from the plugin's `match/type.ts` rather than imported: that
 * module is inside the plugin's pure half and importing it here would pull the
 * health-report types across a package boundary for one lookup table.
 */
const WEIGHT_BY_FACE: Readonly<Record<string, number>> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  regular: 400,
  normal: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
};

function resolveWeight(weight: string | number): number | undefined {
  if (typeof weight === "number") return weight;
  const key = weight.toLowerCase().replace(/italic|oblique/g, "").replace(/[\s_-]+/g, "");
  return key.length === 0 ? 400 : WEIGHT_BY_FACE[key];
}

/**
 * @returns undefined when the text style cannot be resolved even by value — a
 *          Text with no `style` is invalid, so the caller reports it rather
 *          than emitting a tree that fails its own schema.
 */
export function text(theme: NormalizedTheme, n: FrameIRNode): TextProps | undefined {
  if (!n.text) return undefined;
  const style = canonicalRef(theme, n.text.styleRef, "type") ?? matchTypeToken(theme, n);
  if (!style) return undefined;
  const out: TextProps = { content: n.text.characters, style };
  const tone = canonicalRef(theme, n.fill?.tokenRef, "color");
  if (tone) out.tone = tone;
  const clamp = truncateLines(n);
  if (clamp !== undefined) out.truncate = clamp;
  /**
   * Figma's per-layer case setting, which is presentation and not content.
   *
   * The file stores "My account" and displays "MY ACCOUNT". Dropping this was
   * the only reason a page of correctly-bound headings rendered in the wrong
   * case, and the alternative — uppercasing the characters — would corrupt the
   * string for every other consumer of the same tree. Figma's `ORIGINAL` is
   * absent from the IR rather than recorded — see `textCaseSchema` — so there
   * is no default to filter out here.
   */
  if (n.text.textCase) out.textCase = TEXT_CASE[n.text.textCase];
  if (isUntrimmed(n)) out.trim = "none";
  // Auto-width never wraps in Figma. A clamp already owns the line count.
  if (n.text.autoResize === "WIDTH_AND_HEIGHT" && clamp === undefined) out.wrap = false;
  return out;
}

/**
 * Whether Figma drew this layer WITHOUT vertical trim.
 *
 * The IR does not carry `leadingTrim`, but the box gives it away: untrimmed, a
 * layer is exactly `lines × lineHeight` tall; trimmed, it hugs cap-height to
 * baseline and comes out several pixels short of that. Only a match counts —
 * anything else keeps the renderer's default, which is the trimmed box.
 */
function isUntrimmed(n: FrameIRNode): boolean {
  const t = n.text;
  if (!t || typeof t.lineHeight !== "number" || !(t.lines > 0)) return false;
  return Math.abs(n.geometry.relBbox.h - t.lines * t.lineHeight) <= 0.5;
}

/** Figma's `textCase` -> the DSL's `textCase`. `SMALL_CAPS*` has no DSL spelling. */
const TEXT_CASE: Readonly<Record<TextCaseValue, "upper" | "lower" | "title">> = {
  UPPER: "upper",
  LOWER: "lower",
  TITLE: "title",
};

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
