/**
 * Colour matching, including the measured comparison that decided the metric.
 *
 * The last block is deliberately written as executable documentation: it records
 * what each (metric, threshold) pair actually does to the two colours the build
 * spec called out, so the choice in DEFAULT_LINT_OPTIONS can be audited rather
 * than taken on trust.
 */
import { describe, expect, it } from "vitest";
import {
  colorFamily,
  deltaE2000,
  deltaE76,
  isGradient,
  matchColor,
  parseSolid,
  sameSolid,
} from "../src/match/color.js";
import { themeSnapshot } from "./health-fixtures.js";

const colors = themeSnapshot().colors;
const cie76 = { metric: "cie76" as const, threshold: 13, maxCandidates: 3 };

describe("parseSolid", () => {
  it("reads the two hex forms the IR emits", () => {
    expect(parseSolid("#FFFFFF")).toEqual({ hex: "#ffffff", alpha: 1 });
    expect(parseSolid("#00000080")).toEqual({ hex: "#000000", alpha: 128 / 255 });
  });

  it("refuses everything that isn't a solid", () => {
    expect(parseSolid("GRADIENT_LINEAR(#fff 0%, #000 100%)")).toBeNull();
    expect(parseSolid("IMAGE:FILL")).toBeNull();
    expect(parseSolid("MIXED")).toBeNull();
    expect(parseSolid(undefined)).toBeNull();
  });

  it("recognises gradients", () => {
    expect(isGradient("GRADIENT_RADIAL(...)")).toBe(true);
    expect(isGradient("#ffffff")).toBe(false);
  });
});

describe("sameSolid", () => {
  it("treats 8-digit hexes as the same colour when RGB and alpha match", () => {
    expect(sameSolid("#ffffff33", "#FFFFFF33")).toBe(true);
    expect(sameSolid("#ffffff", "#ffffff")).toBe(true);
  });

  it("does not collapse opaque white onto translucent white", () => {
    expect(sameSolid("#ffffff", "#ffffff33")).toBe(false);
  });
});

describe("ΔE", () => {
  it("is zero for identical colours", () => {
    expect(deltaE76("#2939a3", "#2939a3")).toBe(0);
    expect(deltaE2000("#2939a3", "#2939a3")).toBe(0);
  });

  it("puts black and white the full L* range apart", () => {
    expect(deltaE76("#000000", "#ffffff")).toBeCloseTo(100, 0);
  });

  it("is symmetric", () => {
    expect(deltaE76("#ff4b32", "#f52833")).toBeCloseTo(deltaE76("#f52833", "#ff4b32"), 10);
    expect(deltaE2000("#ff4b32", "#f52833")).toBeCloseTo(deltaE2000("#f52833", "#ff4b32"), 10);
  });
});

describe("exact matching", () => {
  it("prefers the core ramp over a semantic alias for a shared value", () => {
    // Nine tokens in this palette are #ffffff. `core_neu_00` states a colour;
    // `background_main_surface` states an intent no hex can prove.
    const match = matchColor("#ffffff", colors, cie76)!;
    expect(match.kind).toBe("exact");
    expect(match.winner.ref).toBe("color.core_neu_00");
    expect(match.candidates).toHaveLength(1);
  });

  it("matches the rgb of a translucent paint, since opacity rides alongside", () => {
    const match = matchColor("#ffffff80", colors, cie76)!;
    expect(match.kind).toBe("exact");
    expect(match.winner.ref).toBe("color.core_neu_00");
  });
});

describe("near matching", () => {
  it("scopes candidates to the nearest family", () => {
    // core_error_500 is numerically between the two primaries under CIE76, and
    // is excluded anyway: a brand red is not an error red.
    const match = matchColor("#ff4b32", colors, cie76)!;
    expect(match.kind).toBe("near");
    expect(match.candidates.map((c) => c.entry.ref)).toEqual([
      "color.core_prim_400",
      "color.core_prim_500",
    ]);
  });

  it("ranks by distance and dedupes by hex", () => {
    const match = matchColor("#000000", colors, cie76)!;
    const hexes = match.candidates.map((c) => c.entry.hex);
    expect(new Set(hexes).size).toBe(hexes.length);
    expect(match.candidates[0]!.distance).toBeLessThan(match.candidates[1]!.distance);
  });

  it("proposes nothing when the nearest token is too far away", () => {
    expect(matchColor("#7fff00", colors, { ...cie76, threshold: 2 })).toBeNull();
  });

  it("honours maxCandidates", () => {
    const match = matchColor("#000000", colors, { ...cie76, threshold: 40, maxCandidates: 1 })!;
    expect(match.candidates).toHaveLength(1);
  });
});

describe("colorFamily", () => {
  it("drops a trailing ramp step and nothing else", () => {
    expect(colorFamily("core_prim_400")).toBe("core_prim");
    expect(colorFamily("core_neu_00")).toBe("core_neu");
    expect(colorFamily("text_main_high")).toBe("text_main_high");
  });
});

describe("the shipped metric, measured", () => {
  const near = (raw: string, metric: "cie76" | "ciede2000", threshold: number) =>
    matchColor(raw, colors, { metric, threshold, maxCandidates: 3 })?.candidates.map(
      (c) => c.entry.ref,
    ) ?? [];

  it("CIE76 at 13 — the shipped default — gives the brand red its two primaries", () => {
    expect(near("#ff4b32", "cie76", 13)).toEqual([
      "color.core_prim_400",
      "color.core_prim_500",
    ]);
  });

  it("CIE76 at 10 — the textbook figure — strands the brand red entirely", () => {
    // ΔE76 to core_prim_400 is 10.98, which is ΔE00 6.94: unmistakably the same
    // red. A threshold of 10 leaves 36 layers with no lever at all, which is why
    // the default is 13.
    expect(near("#ff4b32", "cie76", 10)).toEqual([]);
    expect(near("#000000", "cie76", 10)).toEqual(["color.core_neu_950"]);
  });

  it("CIEDE2000 at 10 pulls in the error ramp, which is the wrong family", () => {
    expect(near("#ff4b32", "ciede2000", 10)[0]).toBe("color.core_error_400");
  });

  it("only a 0.04-wide ΔE window gives 2 for the red and 1 for black at once", () => {
    // The build spec predicted (#ff4b32 -> 2, #000000 -> 1). Both hold only for
    // a threshold above the red's second candidate and below the black's, and
    // those two distances are 0.04 ΔE apart. A default tuned into that window
    // would be a number chosen to pass a test, so the shipped default is 13 and
    // the black reports two candidates. This test pins the arithmetic so the
    // decision stays auditable.
    const redSecond = deltaE76("#ff4b32", "#e10a15"); // core_prim_500
    const blackSecond = deltaE76("#000000", "#212121"); // core_neu_900

    expect(redSecond).toBeCloseTo(12.66, 1);
    expect(blackSecond).toBeCloseTo(12.7, 1);
    expect(blackSecond - redSecond).toBeLessThan(0.1);
    expect(blackSecond - redSecond).toBeGreaterThan(0);

    // Inside the window both predictions hold...
    const inside = (redSecond + blackSecond) / 2;
    expect(near("#ff4b32", "cie76", inside)).toHaveLength(2);
    expect(near("#000000", "cie76", inside)).toHaveLength(1);

    // ...and at every round threshold either side, they do not.
    for (const threshold of [10, 11, 12, 13, 14, 15]) {
      const red = near("#ff4b32", "cie76", threshold).length;
      const black = near("#000000", "cie76", threshold).length;
      expect(red === 2 && black === 1).toBe(false);
    }
  });
});
