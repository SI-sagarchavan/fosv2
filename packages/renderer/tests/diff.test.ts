import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { diff, findRegions } from "../src/harness/diff.js";
import { mapRegionsToNodes } from "../src/harness/mapRegions.js";

function solidPng(w: number, h: number, rgba: [number, number, number, number]): Buffer {
  const img = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    img.data[o] = rgba[0];
    img.data[o + 1] = rgba[1];
    img.data[o + 2] = rgba[2];
    img.data[o + 3] = rgba[3];
  }
  return PNG.sync.write(img);
}

function paintRect(
  img: PNG,
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: [number, number, number, number],
): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const o = (yy * img.width + xx) * 4;
      img.data[o] = rgba[0];
      img.data[o + 1] = rgba[1];
      img.data[o + 2] = rgba[2];
      img.data[o + 3] = rgba[3];
    }
  }
}

describe("diff", () => {
  it("returns score 0 for identical images", () => {
    const a = solidPng(10, 10, [0, 0, 0, 255]);
    const result = diff(a, a);
    expect(result.score).toBe(0);
    expect(result.regions).toEqual([]);
  });

  it("reports regions for a mismatched cluster", () => {
    const expected = solidPng(40, 40, [0, 0, 0, 255]);
    const actualImg = PNG.sync.read(solidPng(40, 40, [0, 0, 0, 255]));
    paintRect(actualImg, 5, 5, 8, 6, [255, 0, 0, 255]);
    const actual = PNG.sync.write(actualImg);

    const result = diff(actual, expected, 0.01);
    expect(result.score).toBeGreaterThan(0);
    expect(result.regions.length).toBeGreaterThanOrEqual(1);
    expect(result.regions[0]!.area).toBeGreaterThan(0);
    expect(result.diffPng.length).toBeGreaterThan(0);
  });

  it("sorts regions by area descending", () => {
    const mask = new Uint8Array(20 * 20);
    // small cluster at 0,0
    mask[0] = 1;
    mask[1] = 1;
    // large cluster at 10,10
    for (let y = 10; y < 15; y++) for (let x = 10; x < 15; x++) mask[y * 20 + x] = 1;
    const regions = findRegions(mask, 20, 20);
    expect(regions[0]!.area).toBeGreaterThanOrEqual(regions[1]!.area);
  });
});

describe("mapRegionsToNodes", () => {
  it("returns node ids whose boxes intersect each region", () => {
    const regions = [{ x: 10, y: 10, w: 20, h: 20, area: 400 }];
    const boxes = [
      { id: "card", x: 0, y: 0, w: 100, h: 100 },
      { id: "badge", x: 15, y: 15, w: 10, h: 10 },
      { id: "far", x: 200, y: 200, w: 10, h: 10 },
    ];
    const mapped = mapRegionsToNodes(regions, boxes);
    expect(mapped[0]!.nodeIds).toContain("badge");
    expect(mapped[0]!.nodeIds).toContain("card");
    expect(mapped[0]!.nodeIds).not.toContain("far");
    // smaller box first
    expect(mapped[0]!.nodeIds[0]).toBe("badge");
  });
});
