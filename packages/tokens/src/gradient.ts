/**
 * Gradient stop analysis. Pure — shared by the validator (W6, E4) and the CSS
 * emitter, so the thing that warns and the thing that fixes can never drift.
 */

import type { GradientStop } from "./types.js";

export interface StopRun {
  percent: number;
  /** Index of the first stop in the run. */
  start: number;
  /** Number of stops in the run. */
  length: number;
}

/** Maximal runs of consecutive stops sharing a percent, length >= `min`. */
export function stopRuns(stops: readonly GradientStop[], min = 3): StopRun[] {
  const runs: StopRun[] = [];
  let start = 0;
  for (let i = 1; i <= stops.length; i++) {
    const same = i < stops.length && stops[i]!.percent === stops[start]!.percent;
    if (!same) {
      const length = i - start;
      if (length >= min) runs.push({ percent: stops[start]!.percent, start, length });
      start = i;
    }
  }
  return runs;
}

function sameStop(a: GradientStop, b: GradientStop): boolean {
  return a.percent === b.percent && a.opacity === b.opacity && a.color === b.color;
}

/**
 * Collapse runs of 3+ stops at the same percent down to the run's first and
 * last stop, then drop an adjacent stop that is identical in every field.
 *
 * Everything between the first and last of such a run is unreachable: a CSS
 * gradient interpolates between positions, and a zero-width span has nothing to
 * interpolate across. The middle stops are dead weight that only make the
 * emitted rule longer and the diff noisier.
 *
 * With the real `gradient_nue_vert_1` from the fanxp-web-renderer export —
 * percents 20,100,100,100,100 carrying opacities 0,100,25,25,25 — this yields
 * three stops (20, 100, 100), because the run's first and last stop differ in
 * opacity and both are meaningful. When the run's members are identical it
 * yields two (20, 100).
 */
export function coalesceStops(stops: readonly GradientStop[]): GradientStop[] {
  const runs = stopRuns(stops, 3);
  let out: GradientStop[];
  if (runs.length === 0) {
    out = [...stops];
  } else {
    out = [];
    let i = 0;
    while (i < stops.length) {
      const run = runs.find((r) => r.start === i);
      if (run) {
        out.push(stops[run.start]!, stops[run.start + run.length - 1]!);
        i += run.length;
      } else {
        out.push(stops[i]!);
        i += 1;
      }
    }
  }
  return out.filter((s, i, arr) => i === 0 || !sameStop(s, arr[i - 1]!));
}

/** Indices where a stop's percent is strictly less than its predecessor's (E4). */
export function decreasingStopIndexes(stops: readonly GradientStop[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < stops.length; i++) {
    if (stops[i]!.percent < stops[i - 1]!.percent) out.push(i);
  }
  return out;
}
