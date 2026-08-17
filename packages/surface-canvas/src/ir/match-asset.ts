/**
 * Which part of the design did this image come from?
 *
 * The designer exports a region from Figma the ordinary way and drops the file
 * in. That act already carries almost everything needed to place it — the file
 * is named after the layer, and its pixel size is that layer's box times the
 * export scale — so asking them to then point at the layer as well is asking
 * for information they have already given.
 *
 * Two strong signals, one weak one, and a refusal to guess when none of them
 * fire. A wrong auto-mapping paints the right picture onto the wrong element,
 * which is harder to notice and harder to diagnose than no mapping at all.
 *
 * PURE. No Figma, no I/O.
 */
import type { FrameIRNode } from "./schema.js";

/** What was dropped, as the browser reports it. */
export interface UploadedImage {
  /** Including the extension, as it came off disk. */
  fileName: string;
  /** Natural pixel size of the file. */
  width: number;
  height: number;
}

export interface TargetMatch {
  id: string;
  name: string;
  /** The node's box, in design units. */
  width: number;
  height: number;
  score: number;
  /** Export scale the dimensions agreed at, if they did. */
  scale?: number;
  /** Why this scored — shown in the panel, so a mapping is never mysterious. */
  reasons: string[];
}

/**
 * Scales Figma offers in its export dialog, plus a half for the rare
 * downscaled export. Ordered so an exact 1x beats a coincidental 2x.
 */
const EXPORT_SCALES = [1, 2, 3, 4, 0.5, 1.5] as const;

/** Rounding drift between a Figma box and an exported pixel count. */
const DIMENSION_TOLERANCE_PX = 1.5;

/** Aspect agreement good enough to be worth a nudge, as a ratio. */
const ASPECT_TOLERANCE = 0.02;

/**
 * A node smaller than this is not something anyone exports as a background.
 * Excluding them stops a 4x4 vector scoring on aspect ratio alone.
 */
const MIN_TARGET_PX = 24;

const SCORE = {
  /** The filename IS the layer name. Figma names exports after the layer. */
  nameExact: 60,
  /** One contains the other — "Top Header" vs "Top Header bg". */
  namePartial: 25,
  /** Pixel dimensions agree at a real export scale. */
  dimensions: 50,
  /** Same shape, any size. Weak on its own; a tiebreaker beside something else. */
  aspect: 15,
} as const;

/**
 * Confident enough to apply without asking.
 *
 * Deliberately set above either strong signal alone: a name match OR a
 * dimension match is suggestive, and both together is as close to certain as
 * this gets. One signal on its own still surfaces as the top suggestion — it
 * just does not get applied silently.
 */
export const AUTO_APPLY_SCORE = SCORE.nameExact + SCORE.dimensions;

export interface MatchOptions {
  /** Ids already painted by another asset; ranked lower, never excluded. */
  taken?: ReadonlySet<string>;
  limit?: number;
}

/**
 * Rank every node in the frame against the upload, best first.
 *
 * Returns an empty list rather than a bad guess when nothing scores: the panel
 * then asks, which is the correct outcome for an image that does not obviously
 * belong anywhere.
 */
export function matchAssetToTargets(
  root: FrameIRNode,
  upload: UploadedImage,
  options: MatchOptions = {},
): TargetMatch[] {
  const taken = options.taken ?? new Set<string>();
  const limit = options.limit ?? 5;
  const wanted = normalizeFileName(upload.fileName);

  const matches: TargetMatch[] = [];
  walk(root, (node) => {
    const { w, h } = node.geometry.bbox;
    if (w < MIN_TARGET_PX || h < MIN_TARGET_PX) return;

    const reasons: string[] = [];
    let score = 0;

    // --- name -------------------------------------------------------------
    const layer = slug(node.name);
    if (layer && wanted) {
      if (layer === wanted) {
        score += SCORE.nameExact;
        reasons.push(`named after this layer`);
      } else if (layer.includes(wanted) || wanted.includes(layer)) {
        score += SCORE.namePartial;
        reasons.push(`filename resembles "${node.name}"`);
      }
    }

    // --- dimensions -------------------------------------------------------
    const scale = matchingScale(upload, w, h);
    if (scale !== undefined) {
      score += SCORE.dimensions;
      reasons.push(scale === 1 ? "exact pixel size" : `exact size at ${scale}x export`);
    } else if (aspectAgrees(upload, w, h)) {
      // Only when the dimensions did NOT match: an exact match already implies
      // the aspect, and counting both would double-reward one fact.
      score += SCORE.aspect;
      reasons.push("same proportions");
    }

    if (score === 0) return;

    /**
     * Something else already paints this node.
     *
     * Ranked down rather than removed: two backgrounds on one element is legal
     * — a plate under a pattern — so it must stay pickable, just not be the
     * automatic answer.
     */
    if (taken.has(node.id)) {
      score -= SCORE.namePartial;
      reasons.push("already painted by another asset");
    }

    matches.push({
      id: node.id,
      name: node.name,
      width: Math.round(w),
      height: Math.round(h),
      score,
      ...(scale !== undefined ? { scale } : {}),
      reasons,
    });
  });

  return matches
    .sort((a, b) => b.score - a.score || preferLarger(a, b) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** True when the top match is worth applying without asking. */
export function isConfident(matches: readonly TargetMatch[]): boolean {
  const best = matches[0];
  if (!best || best.score < AUTO_APPLY_SCORE) return false;
  // A tie is not confidence. Two nodes scoring identically — the usual cause is
  // a repeated component — means the matcher cannot tell them apart, and
  // picking one at random is exactly the silent-wrong-answer case to avoid.
  const runnerUp = matches[1];
  return !runnerUp || runnerUp.score < best.score;
}

/**
 * The export scale at which the file's pixels equal the node's box.
 *
 * Both axes must agree at the SAME scale. Checking them independently would
 * match a 1366x418 node to a 1366x836 file, which is not that region at all.
 */
function matchingScale(upload: UploadedImage, w: number, h: number): number | undefined {
  for (const scale of EXPORT_SCALES) {
    const dw = Math.abs(upload.width - w * scale);
    const dh = Math.abs(upload.height - h * scale);
    // Tolerance scales with the export: a 4x export of a fractional box drifts
    // four times as far as a 1x one.
    const slack = DIMENSION_TOLERANCE_PX * scale;
    if (dw <= slack && dh <= slack) return scale;
  }
  return undefined;
}

function aspectAgrees(upload: UploadedImage, w: number, h: number): boolean {
  if (h === 0 || upload.height === 0) return false;
  const a = upload.width / upload.height;
  const b = w / h;
  return Math.abs(a - b) / Math.max(a, b) <= ASPECT_TOLERANCE;
}

/** Bigger wins a tie: a background is the larger of two nested candidates. */
function preferLarger(a: TargetMatch, b: TargetMatch): number {
  return b.width * b.height - a.width * a.height;
}

/**
 * `Top Header@2x.png` -> `top_header`.
 *
 * Strips the extension, Figma's scale suffix, and the ` (1)` a browser adds to
 * a duplicate download — none of which say anything about which layer this is.
 */
export function normalizeFileName(fileName: string): string {
  return slug(
    fileName
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/@[\d.]+x$/i, "")
      .replace(/\s*\(\d+\)$/, ""),
  );
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function walk(node: FrameIRNode, visit: (node: FrameIRNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}
