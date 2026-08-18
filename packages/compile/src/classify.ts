/**
 * What kind of DSL node is this IR node, and should it exist at all?
 *
 * Two decisions, and the second matters as much as the first. A faithful tree
 * is not a 1:1 copy of the IR — Figma draws a filled frame as a frame plus a
 * rectangle, a ":" as six 2x2 ellipses, an icon as a group of paths. Emitting
 * all of those produces a tree nobody can read that renders identically to one
 * half the size.
 *
 * Every rule here is decidable from the IR alone. Where it cannot be decided,
 * the compiler emits the safe thing and records a note, rather than guessing.
 */

import {
  MAX_ICON_PX,
  compositePlacement,
  isVectorOnly,
  type FrameIRNode,
} from "@fanos/surface-canvas/ir";
import { layoutBox } from "./geometry.js";
import { isMeaningful } from "./ids.js";

export type DslType =
  | "Box"
  | "Stack"
  | "Overlay"
  | "Text"
  | "Image"
  | "Icon"
  | "Divider"
  | "Button";

/**
 * Figma components the designer has declared to be a DSL primitive.
 *
 * Keyed by `componentKey`, not by name. The NAME is what decides — a master
 * called `atom_button` is the designer saying "this is a button" — but a name
 * is edited, overridden per instance, and typed differently by two people,
 * while the key is exact and survives a rename. So the name proposes the entry
 * and the key is what it is stored against.
 *
 * This is the one thing that cannot be read off the IR. Everything else in this
 * file is a field read: a TEXT node is a Text, an auto-layout frame is a Stack.
 * Nothing in a frame's geometry distinguishes a button from a rounded box with
 * a label in it, because at rest there is no difference — the difference is
 * that one is pressable, and Figma has nowhere to record that.
 */
export type PrimitiveMap = Readonly<Record<string, DslType>>;

/**
 * How thin counts as a line, in px.
 *
 * Not `<= 1`. A rule nested in a component instance comes back through a
 * transform and arrives as 1.0000104904174805 — every hairline in the fixtures
 * card did — so an exact bound silently classifies them all as boxes. The
 * slack is well under the 2px lower bound for a real thin box.
 */
const HAIRLINE = 1.5;

/**
 * A line: one dimension collapsed.
 *
 * Figma stores rules two ways and both have to be caught. A drawn rule is a
 * zero-height VECTOR. A rule inside a component is usually a childless FRAME
 * filled with a border colour — same pixels, different node type — and treating
 * that one as a Box paints its padding: the fixtures card's 552x1 hairlines
 * came out as 33px grey bars, because a 1px box with 16px padding is 33px tall.
 *
 * The box is the ROTATED one. A rule laid flat reports its dimensions
 * transposed, so reading `relBbox` here would miss exactly the rules that
 * needed catching.
 */
export function isRule(n: FrameIRNode): boolean {
  const { w, h } = layoutBox(n);
  if (Math.min(w, h) > HAIRLINE || Math.max(w, h) <= 2) return false;

  if (n.type === "VECTOR") return true;

  // A frame is only a rule if it has nothing inside it and is actually painted.
  // An unpainted sliver is a spacer, and drawing a line through it would invent
  // a border the design does not have.
  return (
    (n.type === "FRAME" || n.type === "OTHER") &&
    (n.children ?? []).length === 0 &&
    (n.fill !== null || n.stroke !== null)
  );
}

/** Children that participate in flow, as opposed to being absolutely placed. */
export function flowChildren(n: FrameIRNode): FrameIRNode[] {
  return (n.children ?? []).filter((c) => c.layout.positioning !== "absolute");
}

export function hasAbsoluteChild(n: FrameIRNode): boolean {
  return (n.children ?? []).some((c) => c.layout.positioning === "absolute");
}

export function classify(n: FrameIRNode, primitives: PrimitiveMap = {}): DslType {
  /**
   * A declared primitive wins over everything below.
   *
   * Deliberately first. A button IS an auto-layout frame with a label, so every
   * rule after this one would classify it as a Stack and be right about the
   * geometry and wrong about the thing.
   */
  const declared = n.componentKey ? primitives[n.componentKey] : undefined;
  if (declared) return declared;

  if (n.text !== undefined) return "Text";
  /**
   * An image fill on a container is paint, not a leaf. Marking that fill as a
   * background bound to the same node must not swallow the children — they are
   * the UI. A childless image (or one bound to a *different* node) stays Image.
   */
  if (n.image !== undefined) {
    const selfBackground = n.background?.targetId === n.id;
    if (!selfBackground || (n.children ?? []).length === 0) return "Image";
  }
  if (isRule(n)) return "Divider";
  /**
   * A vector is an Icon only if it is ICON-SIZED.
   *
   * Without the guard every VECTOR became an Icon at any size, and the Icon
   * renderer squares its box — it takes one `size` and writes it to both width
   * and height. So the fixtures header's 1368x116 diagonal swoosh rendered as a
   * 1368x1368 block of container colour, and a 596x1013 gradient plate as a
   * 1013x1013 one. Two nodes, and they covered the page.
   *
   * Anything larger is decorative geometry: it falls through to `Box`, which
   * keeps the node's real box and its paint. That is not a reproduction — the
   * IR carries no path data, so a swoosh becomes a rectangle — but it is the
   * shape and colour the design actually occupies there, and the compiler says
   * so in a note. A designer who needs the real artwork marks it on the Assets
   * tab and it ships as a bitmap.
   */
  if (n.type === "VECTOR") return isIconSized(n) ? "Icon" : "Box";

  const kids = n.children ?? [];
  if (kids.length === 0) return "Box";

  /**
   * Auto-layout means a Stack, even when one child is absolutely positioned.
   *
   * Demoting such a frame to an Overlay is expensive: EVERY child of an Overlay
   * carries `place` (S8), so one absolute sibling converted the whole frame to
   * absolute positioning and discarded the row Figma actually flows. Measured
   * on the fixtures page, a 333px auto-layout row of three buttons collapsed to
   * 72px — nothing was left in flow for it to hug — and its subtree shifted by
   * 262px.
   *
   * Figma treats an absolute child as an exception INSIDE a layout, not as an
   * abandonment of it, and CSS agrees: that child gets `position: absolute`
   * against a `position: relative` parent while its siblings keep flowing. Only
   * the child Figma placed is placed.
   */
  if (n.layout.mode !== "none") return "Stack";

  // No auto-layout: Figma flows nothing here, so every child is positioned by
  // its own box. That is exactly what Overlay means.
  return "Overlay";
}

/**
 * Does this mark paint its target's whole surface, or sit at a position inside
 * it?
 *
 * This is the decision that used to not exist, and its absence was the single
 * biggest source of wrong output from a marked image. Every mark was folded
 * into its target's surface as a centred `cover` layer, so a 200x80 plate at
 * (40,120) inside a 1170x400 header rendered as a full-bleed wash. The bitmap
 * was present, correctly resolved, and in completely the wrong place.
 *
 * Two things paint a surface:
 *
 *   - a mark whose box COVERS its target. That really is the element's
 *     background, and CSS `background-image` reproduces it exactly.
 *   - a TILE, whatever its box. A repeating pattern is defined by its tile
 *     size, not by the rectangle the designer happened to draw it in, and
 *     `background-repeat` is the only honest way to render one.
 *
 * Everything else is a picture at a position, and belongs in the tree as an
 * Image node with a box the geometry gate can actually check.
 *
 * @param source the marked image layer
 * @param target the node the binding points at — NOT necessarily the parent
 */
export function paintsAsSurface(
  sources: readonly FrameIRNode[],
  target: FrameIRNode,
  binding: { fit?: string; targetId: string },
): boolean {
  if (binding.targetId !== target.id) return false;
  if (binding.fit === "repeat") return true;
  // The UNION, so a composite is judged as the flattened bitmap it becomes.
  // Any single member of a four-layer header covers nothing on its own.
  return compositePlacement(sources, target).covers;
}

/**
 * Is this node just how Figma spells its parent's fill?
 *
 * A frame with a background is stored as the frame plus a child rectangle at
 * exactly the frame's size. That rectangle is not a node in any meaningful
 * sense — it is the parent's `surface` — and emitting it doubles the tree while
 * changing nothing on screen.
 *
 * Deliberately strict: same box within a pixel, no text, no image, no children
 * of its own. Anything looser starts swallowing real content.
 */
export function isFillPlate(n: FrameIRNode, parent: FrameIRNode): boolean {
  if (n.text !== undefined || n.image !== undefined) return false;
  if ((n.children ?? []).length > 0) return false;
  if (n.fill === null && n.stroke === null) return false;
  if (isRule(n)) return false;
  const a = n.geometry.relBbox;
  const b = parent.geometry.relBbox;
  return Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1 && Math.abs(a.x) < 1 && Math.abs(a.y) < 1;
}

function isIconSized(n: FrameIRNode): boolean {
  const { w, h } = layoutBox(n);
  return w <= MAX_ICON_PX && h <= MAX_ICON_PX;
}

/**
 * A cluster of vector paths that together draw one glyph.
 *
 * Figma has no notion of "icon", so a logo arrives as a frame or group of
 * `Vector` children. The IR carries no path data at all, so the cluster
 * collapses to a single `Icon` and the renderer draws a registered glyph.
 *
 * **Size is the test, not path count.** This used to bail above six children,
 * on the theory that a glyph is a few paths. Real artwork is not: the club
 * crests on the fixtures page are 99 vector paths inside a 44x30 box. Each one
 * failed the cap, so the compiler recursed and emitted 99 separate Icons — 99
 * dashed "?" placeholders packed into a 44x30 square, which is the noise the
 * crests rendered as. One page produced 408 of them.
 *
 * A 44x30 box is a logo whether it is drawn with three paths or three hundred.
 * What it cannot be is a background, and the size guard already says that.
 *
 * The subtree test is RECURSIVE for the same reason. A crest arrives wrapped:
 * `birmingham-phoenix 1` holds nine vectors plus a "Clip path group", and a
 * check that only looked at direct childless children rejected it and matched
 * further down — on the anonymous inner `Group`, losing the one name in the
 * subtree worth having. Matching at the top keeps `birmingham_phoenix_1`, which
 * is a glyph name a registry can actually resolve.
 */
export function isIconGroup(n: FrameIRNode): boolean {
  const kids = n.children ?? [];
  if (kids.length === 0) return false;
  if (n.text !== undefined || n.image !== undefined) return false;
  if (!isIconSized(n)) return false;
  // `isVectorOnly` is shared with the plugin panel, from the IR package, so the
  // set of clusters the compiler collapses and the set the Assets tab offers to
  // ship as bitmaps are defined once and cannot drift apart.
  return kids.every(isVectorOnly);
}

/**
 * The layer in a collapsed icon whose name is worth keeping.
 *
 * A crest arrives wrapped in a component instance: `Teams` (60x60) holds one
 * child, `manchester-super-giants 1`, which holds the paths. Naming the glyph
 * after the outermost node gives sixteen different crests the same name —
 * "teams" — and no registry can ever resolve which club it is. The name that
 * identifies the artwork is one level down.
 *
 * Descends only through SINGLE-child wrappers. The moment a node has real
 * structure, its own name is the one that describes the whole thing, and going
 * deeper would name a glyph after an arbitrary first path.
 *
 * @returns the deepest meaningful name in the wrapper chain, or the node itself
 *          when the chain offers nothing better.
 */
export function iconNameSource(n: FrameIRNode): FrameIRNode {
  let best = n;
  let cursor = n;
  while ((cursor.children ?? []).length === 1) {
    const only = cursor.children![0]!;
    if (isMeaningful(only.name)) best = only;
    cursor = only;
  }
  return best;
}

/**
 * Decorative vector geometry: a path too large to be a glyph.
 *
 * Reported rather than silently approximated, because the approximation is
 * lossy in a way the designer can fix — marking it on the Assets tab ships the
 * real artwork as a bitmap.
 */
export function isDecorativeVector(n: FrameIRNode): boolean {
  return n.type === "VECTOR" && !isIconSized(n) && !isRule(n);
}
