/**
 * Pixel diff with mismatch regions.
 *
 * `regions` is not optional. A scalar score tells the repair loop nothing about
 * WHERE it went wrong; the repair step receives only the failing regions plus
 * the node ids under them.
 */

import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

export interface DiffRegion {
  /** Inclusive pixel bounds. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Number of mismatched pixels in this cluster. */
  area: number;
}

export interface DiffResult {
  /** 0–1, mismatched / total. */
  score: number;
  /** Heatmap PNG. */
  diffPng: Buffer;
  /** Bounding boxes of connected mismatch clusters, sorted by area desc. */
  regions: DiffRegion[];
  width: number;
  height: number;
  mismatchCount: number;
}

export function diff(actualPng: Buffer, expectedPng: Buffer, threshold = 0.1): DiffResult {
  const actual = PNG.sync.read(actualPng);
  const expected = PNG.sync.read(expectedPng);

  if (actual.width !== expected.width || actual.height !== expected.height) {
    // Resize-mismatch: treat entire frame as one region.
    const w = Math.max(actual.width, expected.width);
    const h = Math.max(actual.height, expected.height);
    const diffImg = new PNG({ width: w, height: h });
    return {
      score: 1,
      diffPng: PNG.sync.write(diffImg),
      regions: [{ x: 0, y: 0, w, h, area: w * h }],
      width: w,
      height: h,
      mismatchCount: w * h,
    };
  }

  const { width, height } = actual;
  const diffImg = new PNG({ width, height });
  const mismatchMask = new Uint8Array(width * height);

  const mismatchCount = pixelmatch(actual.data, expected.data, diffImg.data, width, height, {
    threshold,
    includeAA: true,
  });

  // Build a binary mask of mismatched pixels from the diff alpha channel.
  // pixelmatch paints mismatched pixels with red; detect non-zero red where
  // the two inputs differed by scanning the output.
  for (let i = 0; i < width * height; i++) {
    const di = i * 4;
    // Diff pixels that match are dim/transparent-ish; mismatches are bright red.
    const r = diffImg.data[di] ?? 0;
    const g = diffImg.data[di + 1] ?? 0;
    const b = diffImg.data[di + 2] ?? 0;
    if (r > 50 && r > g && r > b) mismatchMask[i] = 1;
  }

  // Fallback: if pixelmatch reports mismatches but our mask is empty (anti-alias
  // only), mark any non-zero alpha in the diff.
  if (mismatchCount > 0 && !mismatchMask.includes(1)) {
    for (let i = 0; i < width * height; i++) {
      const a = diffImg.data[i * 4 + 3] ?? 0;
      if (a > 0) mismatchMask[i] = 1;
    }
  }

  const regions = findRegions(mismatchMask, width, height);
  const total = width * height;

  return {
    score: total === 0 ? 0 : mismatchCount / total,
    diffPng: PNG.sync.write(diffImg),
    regions,
    width,
    height,
    mismatchCount,
  };
}

/**
 * Connected-component labeling (4-connected) over the mismatch mask.
 * Returns bounding boxes sorted by area descending.
 */
export function findRegions(mask: Uint8Array, width: number, height: number): DiffRegion[] {
  const visited = new Uint8Array(mask.length);
  const regions: DiffRegion[] = [];

  const idx = (x: number, y: number) => y * width + x;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y);
      if (!mask[i] || visited[i]) continue;

      // BFS flood fill
      let minX = x,
        maxX = x,
        minY = y,
        maxY = y,
        area = 0;
      const queue: number[] = [i];
      visited[i] = 1;

      while (queue.length) {
        const cur = queue.pop()!;
        const cx = cur % width;
        const cy = (cur / width) | 0;
        area += 1;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const neighbors = [
          cx > 0 ? cur - 1 : -1,
          cx + 1 < width ? cur + 1 : -1,
          cy > 0 ? cur - width : -1,
          cy + 1 < height ? cur + width : -1,
        ];
        for (const n of neighbors) {
          if (n < 0 || visited[n] || !mask[n]) continue;
          visited[n] = 1;
          queue.push(n);
        }
      }

      regions.push({
        x: minX,
        y: minY,
        w: maxX - minX + 1,
        h: maxY - minY + 1,
        area,
      });
    }
  }

  regions.sort((a, b) => b.area - a.area || a.y - b.y || a.x - b.x);
  return regions;
}
