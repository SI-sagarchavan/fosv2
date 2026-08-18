/**
 * Post-emission cleanups: things the tree is truer without.
 *
 * `emit` transcribes one IR node at a time and cannot see a shape that spans
 * two of them — an image and the frame clipping it. These passes run over the
 * finished node list, where the parent/child relationship is a lookup rather
 * than a recursion, and each one deletes something the DSL already says a
 * better way.
 *
 * The cost of NOT doing this is not cosmetic. Figma's crop mechanics put four
 * raw values on every image, all of them measurements of a bitmap rather than
 * facts about the design, and they differ between two instances of one card
 * that are otherwise identical. That is enough to split a run that should
 * merge, which is why this lands before subtree signatures do.
 *
 * PURE. Reads nothing but the nodes it is given.
 */

import type { FlatNode } from "@fanos/dsl";
import type { Raw } from "./props.js";

export interface CleanupNote {
  kind: "crop-dropped" | "zero-props";
  nodeId: string;
  message: string;
}

export interface CleanupResult {
  nodes: FlatNode[];
  notes: CleanupNote[];
  stats: { cropsDropped: number; rawsDropped: number; zeroProps: number };
}

/**
 * Which passes to run. Every one defaults ON — the switch exists so the
 * before/after pair that documents WHY a pass is here stays reproducible from
 * one input. Turning the crop pass off regenerates the tree whose two feature
 * cards refuse to hash together, which is the whole argument for the pass.
 */
export interface CleanupOptions {
  crop?: boolean;
  zeros?: boolean;
}

export function cleanup(nodes: FlatNode[], options: CleanupOptions = {}): CleanupResult {
  const notes: CleanupNote[] = [];

  const crop = options.crop === false ? { nodes, count: 0, raws: 0 } : dropRedundantCrop(nodes, notes);
  const zeros = options.zeros === false ? { nodes: crop.nodes, count: 0 } : dropZeroValues(crop.nodes, notes);

  return {
    nodes: zeros.nodes,
    notes,
    stats: { cropsDropped: crop.count, rawsDropped: crop.raws, zeroProps: zeros.count },
  };
}

// ---------------------------------------------------------------------------
// 1. Redundant crop geometry
// ---------------------------------------------------------------------------

/** The fits where the box, not the placement, decides what is shown. */
const COVERING_FITS = new Set(["cover", "fill"]);

/** Parents that honour `place.anchor`. Mirrors the validator's S6/S8 rule. */
const ANCHORS_CHILDREN = new Set(["Overlay", "Stack"]);

/**
 * Figma crops by absolutely positioning an oversized bitmap inside a clipping
 * frame. `object-fit: cover` says the same thing in one prop, so the offsets
 * and the pre-crop dimensions are pure transcription of the mechanism.
 *
 * The guard is narrow on purpose. Under `contain` or `none` the position is the
 * whole point — the player-card cutout sits where the designer dragged it, and
 * dropping its box would centre a silhouette that was deliberately off-centre.
 * Being the only child of a clipping parent is what makes "the frame IS the
 * crop window" true; a second child means the offsets are relative layering.
 *
 * What survives is `place.anchor: "fill"` under a parent that can position —
 * NOT nothing. An Overlay child with no anchor is an S8 error and, worse,
 * renders statically: `resolvePlace` returns no `position: absolute` and no
 * insets, so the image loses its box entirely and the thumbnail collapses.
 * `fill` carries no raw value, sets both insets, and is the honest statement of
 * what the clipping frame was doing — cover this box. Under a parent that
 * cannot position a child (a clipping Box), `place` goes altogether, because
 * an anchor there would be S6.
 */
export function dropRedundantCrop(
  nodes: FlatNode[],
  notes: CleanupNote[],
): { nodes: FlatNode[]; count: number; raws: number } {
  const childCount = new Map<string, number>();
  for (const n of nodes) {
    if (n.parent !== null) childCount.set(n.parent, (childCount.get(n.parent) ?? 0) + 1);
  }
  const byNodeId = new Map(nodes.map((n) => [n.id, n]));

  let count = 0;
  let raws = 0;

  const out = nodes.map((node) => {
    if (node.type !== "Image" || node.parent === null) return node;
    if (!COVERING_FITS.has(String(node.props.fit))) return node;
    if (childCount.get(node.parent) !== 1) return node;

    const parent = byNodeId.get(node.parent);
    if (!parent || parent.props.clip !== true) return node;
    if (node.props.place === undefined && node.props.size === undefined) return node;

    const dropped = countRaws(node.props.place) + countRaws(node.props.size);
    const props = { ...node.props };
    delete props.size;
    if (ANCHORS_CHILDREN.has(parent.type)) props.place = { anchor: "fill" };
    else delete props.place;

    /**
     * The box really has changed, and C2 is right to notice.
     *
     * The IR's box for this node is the OVERSIZED BITMAP — 455x369 sitting at
     * -21,-1.5 — because that is what Figma positions to make a crop. We now
     * draw the crop window instead, which is the same picture and a different
     * rectangle. That is a deliberate departure with a reason, which is what
     * `deviations` is for, and `max: 1` keeps any OTHER geometry problem on
     * this image failing.
     */
    props._meta = {
      ...((props._meta as Record<string, unknown> | undefined) ?? {}),
      deviations: [
        ...(((props._meta as { deviations?: unknown[] } | undefined)?.deviations ?? []) as unknown[]),
        {
          check: "C2",
          reason:
            `drawn as the crop window rather than the bitmap: the IR box is the pre-crop ` +
            `image that Figma positions inside "${parent.id}" to make the crop, and object-fit ` +
            `reproduces the same picture from the window's own box`,
          max: 1,
        },
      ],
    };

    count += 1;
    raws += dropped;
    notes.push({
      kind: "crop-dropped",
      nodeId: node.id,
      message:
        `crop geometry dropped — the only child of a clipping "${parent.id}" with fit ` +
        `"${String(node.props.fit)}", so ${dropped} raw values were restating what object-fit ` +
        `already does` +
        (ANCHORS_CHILDREN.has(parent.type) ? '; it fills its crop window instead' : ""),
    });
    return { ...node, props };
  });

  return { nodes: out, count, raws };
}

function countRaws(value: unknown): number {
  if (isRaw(value)) return 1;
  if (Array.isArray(value)) return value.reduce<number>((a, v) => a + countRaws(v), 0);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).reduce<number>((a, v) => a + countRaws(v), 0);
  }
  return 0;
}

function isRaw(value: unknown): value is Raw {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _unbound?: unknown })._unbound === true &&
    typeof (value as { raw?: unknown }).raw === "number"
  );
}

// ---------------------------------------------------------------------------
// 2. Zero-valued props
// ---------------------------------------------------------------------------

/**
 * Prop paths where zero and absent are the same rendered result.
 *
 * Deliberately a list rather than "any zero". `opacity.0` is a token whose zero
 * means invisible, and a `size.w` of 0 is a degenerate box rather than an
 * absent one — deleting either changes the picture. Space is the one family
 * where the renderer's default IS zero, so writing it down says nothing.
 */
const ZEROABLE = [
  /^gap$/,
  /^columnGap$/,
  /^rowGap$/,
  /^inset$/,
  /^peek$/,
  /^space\./,
  /^place\.offset\./,
];

function zeroable(path: string): boolean {
  return ZEROABLE.some((re) => re.test(path));
}

/** A zero length, in either of the two forms the compiler emits. */
function isZeroLength(value: unknown): boolean {
  if (value === "space.0" || value === "-space.0") return true;
  return isRaw(value) && value.raw === 0;
}

/**
 * Strip zero paddings, gaps and offsets, then any object left empty by it.
 *
 * `_meta` is never touched: a deviation's `max: 1` is a count, and a waiver
 * that quietly loses its bound stops bounding anything.
 */
export function dropZeroValues(
  nodes: FlatNode[],
  notes: CleanupNote[],
): { nodes: FlatNode[]; count: number } {
  let count = 0;

  const out = nodes.map((node) => {
    let removed = 0;

    const prune = (value: Record<string, unknown>, prefix: string): Record<string, unknown> => {
      const next: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (path === "_meta" || path.startsWith("_meta.")) {
          next[key] = v;
          continue;
        }
        if (zeroable(path) && isZeroLength(v)) {
          removed += 1;
          continue;
        }
        if (v !== null && typeof v === "object" && !Array.isArray(v) && !isRaw(v)) {
          const inner = prune(v as Record<string, unknown>, path);
          // An object emptied by the pass said only zeroes, so it said nothing.
          if (Object.keys(inner).length > 0) next[key] = inner;
          continue;
        }
        next[key] = v;
      }
      return next;
    };

    const props = prune(node.props, "");
    if (removed === 0) return node;

    count += removed;
    notes.push({
      kind: "zero-props",
      nodeId: node.id,
      message: `${removed} zero-valued space prop(s) dropped — the renderer's default is already 0`,
    });
    return { ...node, props };
  });

  return { nodes: out, count };
}
