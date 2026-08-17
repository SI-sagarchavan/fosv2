/**
 * Working out which part of the design a dropped image came from.
 *
 * The whole feature rests on this: the designer exports a region the ordinary
 * way, and the panel places it without asking. Two ways for that to be wrong,
 * and they are not equally bad — failing to place an image is visible and
 * recoverable, while placing it on the WRONG element paints a real picture in a
 * plausible place and can survive all the way to production. So these tests
 * lean hardest on the cases where it must refuse.
 */
import { describe, expect, it } from "vitest";
import {
  AUTO_APPLY_SCORE,
  isConfident,
  matchAssetToTargets,
  normalizeFileName,
} from "../src/ir/match-asset.js";
import type { FrameIRNode } from "../src/ir/schema.js";

function node(
  id: string,
  name: string,
  box: { x?: number; y?: number; w: number; h: number },
  children: FrameIRNode[] = [],
): FrameIRNode {
  const rect = { x: box.x ?? 0, y: box.y ?? 0, w: box.w, h: box.h };
  return {
    id,
    name,
    type: "FRAME",
    layout: {
      mode: "none",
      gap: null,
      padding: {
        top: { value: 0, unbound: false },
        right: { value: 0, unbound: false },
        bottom: { value: 0, unbound: false },
        left: { value: 0, unbound: false },
      },
      align: null,
      justify: null,
      wrap: false,
      sizing: { w: "fixed", h: "fixed" },
      positioning: "auto",
    },
    geometry: { bbox: rect, relBbox: rect, rotation: 0, aspect: rect.w / rect.h, aspectBucket: "wide" },
    fill: null,
    stroke: null,
    radius: null,
    effects: [],
    opacity: 1,
    clipsContent: false,
    structuralSignature: "s",
    canonicalSignature: "c",
    repeatedSiblings: 1,
    depth: 0,
    childCount: children.length,
    children,
  };
}

/** The fixtures page, near enough: a header, a body, and a card inside it. */
const page = node("1:1", "Page", { w: 1366, h: 1900 }, [
  node("1:2", "Top Header", { w: 1366, h: 418 }),
  node("1:3", "Frame 1984079180", { y: 418, w: 1366, h: 1400 }, [
    node("1:4", "News Card", { w: 534, h: 605 }),
  ]),
]);

describe("normalizeFileName", () => {
  it("strips the extension, the export scale and a browser duplicate suffix", () => {
    expect(normalizeFileName("Top Header@2x.png")).toBe("top_header");
    expect(normalizeFileName("Top Header (1).png")).toBe("top_header");
    expect(normalizeFileName("news-card@3x.PNG")).toBe("news_card");
    expect(normalizeFileName("Top Header.svg")).toBe("top_header");
  });
});

describe("matching a Figma export", () => {
  /** The ordinary case: exported at 2x, named after the layer. */
  it("places a 2x export of a layer with certainty", () => {
    const matches = matchAssetToTargets(page, {
      fileName: "Top Header@2x.png",
      width: 2732,
      height: 836,
    });

    expect(matches[0]).toMatchObject({ id: "1:2", scale: 2 });
    expect(matches[0]!.score).toBeGreaterThanOrEqual(AUTO_APPLY_SCORE);
    expect(isConfident(matches)).toBe(true);
    expect(matches[0]!.reasons.join(" ")).toContain("2x");
  });

  it("places a 1x export the same way", () => {
    const matches = matchAssetToTargets(page, {
      fileName: "Top Header.png",
      width: 1366,
      height: 418,
    });
    expect(matches[0]).toMatchObject({ id: "1:2", scale: 1 });
    expect(isConfident(matches)).toBe(true);
  });

  /**
   * Both axes must agree at the SAME scale. Checking them independently would
   * match a 1366x418 header to a 1366x836 file, which is a different region.
   */
  it("refuses a file whose axes only agree at different scales", () => {
    const matches = matchAssetToTargets(page, {
      fileName: "mystery.png",
      width: 1366,
      height: 836,
    });
    expect(matches.some((m) => m.id === "1:2" && m.scale !== undefined)).toBe(false);
  });

  it("still ranks a renamed file by its pixel size", () => {
    const matches = matchAssetToTargets(page, {
      fileName: "final-final-2.png",
      width: 1366,
      height: 418,
    });
    // Found, because the size is exact — but not applied without asking.
    expect(matches[0]?.id).toBe("1:2");
    expect(isConfident(matches)).toBe(false);
  });

  it("still ranks a resized file by its name", () => {
    const matches = matchAssetToTargets(page, {
      fileName: "Top Header.png",
      width: 800,
      height: 245,
    });
    expect(matches[0]?.id).toBe("1:2");
    expect(isConfident(matches)).toBe(false);
  });
});

describe("when it must not guess", () => {
  /**
   * The dangerous case. Two identical candidates mean the matcher cannot tell
   * them apart — a repeated component is the usual cause — and picking one at
   * random paints a real picture onto an arbitrary one of them.
   */
  it("refuses to auto-apply when two candidates tie", () => {
    const twins = node("2:1", "Page", { w: 1366, h: 900 }, [
      node("2:2", "Card", { w: 534, h: 605 }),
      node("2:3", "Card", { y: 605, w: 534, h: 605 }),
    ]);
    const matches = matchAssetToTargets(twins, {
      fileName: "Card.png",
      width: 534,
      height: 605,
    });

    expect(matches[0]!.score).toBe(matches[1]!.score);
    expect(isConfident(matches)).toBe(false);
  });

  it("returns nothing for an image that resembles no part of the frame", () => {
    expect(
      matchAssetToTargets(page, { fileName: "cat.png", width: 137, height: 991 }),
    ).toEqual([]);
  });

  it("never places anything on the strength of aspect ratio alone", () => {
    // Same 1366:418 proportions, arbitrary size, unrelated name.
    const matches = matchAssetToTargets(page, {
      fileName: "unrelated.png",
      width: 683,
      height: 209,
    });
    expect(isConfident(matches)).toBe(false);
  });

  it("ignores nodes too small to be a background", () => {
    const withIcon = node("3:1", "Page", { w: 1366, h: 900 }, [
      node("3:2", "icon", { w: 16, h: 16 }),
    ]);
    expect(
      matchAssetToTargets(withIcon, { fileName: "icon.png", width: 16, height: 16 }),
    ).toEqual([]);
  });
});

describe("elements that already have an image", () => {
  /**
   * Ranked down, never excluded: two backgrounds on one element is legal — a
   * plate under a pattern — so it has to stay pickable, just not be the
   * automatic answer.
   */
  it("demotes a target another asset already paints", () => {
    const upload = { fileName: "Top Header.png", width: 1366, height: 418 };
    const free = matchAssetToTargets(page, upload);
    const taken = matchAssetToTargets(page, upload, { taken: new Set(["1:2"]) });

    expect(taken[0]?.id).toBe("1:2");
    expect(taken[0]!.score).toBeLessThan(free[0]!.score);
    expect(taken[0]!.reasons.join(" ")).toContain("already painted");
  });
});

describe("ranking", () => {
  it("prefers the larger element when two score the same", () => {
    const nested = node("4:1", "Page", { w: 1366, h: 900 }, [
      node("4:2", "Hero", { w: 600, h: 400 }, [node("4:3", "Inner", { w: 600, h: 400 })]),
    ]);
    // Same size, same aspect, neither name matches: the outer one wins.
    const matches = matchAssetToTargets(nested, {
      fileName: "whatever.png",
      width: 600,
      height: 400,
    });
    expect(matches[0]?.id).toBe("4:2");
  });

  it("gives a reason for every candidate it returns", () => {
    const matches = matchAssetToTargets(page, {
      fileName: "Top Header@2x.png",
      width: 2732,
      height: 836,
    });
    for (const match of matches) expect(match.reasons.length).toBeGreaterThan(0);
  });
});
