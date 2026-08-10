/**
 * Built-in motion scale.
 *
 * Duration and easing are not in the raw theme export — they are a product
 * concern, same as breakpoints. Always present so `revealDelay` and
 * `Carousel.autoplay` can take `duration.*` tokens instead of forcing Raw.
 *
 * Pure. No I/O.
 */

export const DURATION_SCALE = {
  instant: 0,
  fast: 120,
  base: 200,
  slow: 320,
  deliberate: 500,
} as const;

export type DurationLeaf = keyof typeof DURATION_SCALE;

/** Named cubic-bezier curves. Values are CSS-ready. */
export const EASING_SCALE = {
  standard: "cubic-bezier(0.2, 0, 0, 1)",
  enter: "cubic-bezier(0, 0, 0.2, 1)",
  exit: "cubic-bezier(0.4, 0, 1, 1)",
  spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
} as const;

export type EasingLeaf = keyof typeof EASING_SCALE;

export type ReducedMotionPolicy = "respect" | "ignore";

export const DEFAULT_REDUCED_MOTION_POLICY: ReducedMotionPolicy = "respect";

export const DURATION_LEAVES = Object.keys(DURATION_SCALE) as DurationLeaf[];
export const EASING_LEAVES = Object.keys(EASING_SCALE) as EasingLeaf[];

export function durationMs(leaf: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(DURATION_SCALE, leaf)
    ? DURATION_SCALE[leaf as DurationLeaf]
    : undefined;
}

export function easingCurve(leaf: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(EASING_SCALE, leaf)
    ? EASING_SCALE[leaf as EasingLeaf]
    : undefined;
}
