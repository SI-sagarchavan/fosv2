import { describe, expect, it } from "vitest";
import { fingerprintEffect, hasEffectGeometry, matchEffect } from "../src/match/effect.js";
import { themeSnapshot } from "./health-fixtures.js";

const snapshot = themeSnapshot();

describe("hasEffectGeometry", () => {
  it("requires the full composite", () => {
    expect(hasEffectGeometry({ type: "DROP_SHADOW", x: 3 })).toBe(false);
    expect(
      hasEffectGeometry({
        type: "DROP_SHADOW",
        x: 3,
        y: 3,
        blur: 4,
        spread: 0,
        color: "#1A1A1A",
        opacity: 100,
        inset: false,
      }),
    ).toBe(true);
  });
});

describe("matchEffect", () => {
  it("hits shadow.md on the Southern Brave md elevation", () => {
    const match = matchEffect(
      {
        type: "DROP_SHADOW",
        x: 3,
        y: 3,
        blur: 4,
        spread: 0,
        color: "#1A1A1A",
        opacity: 100,
        inset: false,
      },
      snapshot.shadows,
    );
    expect(match?.winner.ref).toBe("shadow.md");
  });

  it("does not near-match a different elevation", () => {
    expect(
      matchEffect(
        {
          type: "DROP_SHADOW",
          x: 8,
          y: 12,
          blur: 24,
          spread: 0,
          color: "#1A1A1A",
          opacity: 100,
          inset: false,
        },
        snapshot.shadows,
      ),
    ).toBeNull();
  });

  it("ignores blurs", () => {
    expect(
      matchEffect(
        {
          type: "LAYER_BLUR",
          x: 0,
          y: 0,
          blur: 4,
          spread: 0,
          color: "#000000",
          opacity: 100,
          inset: false,
        },
        snapshot.shadows,
      ),
    ).toBeNull();
  });
});

describe("fingerprintEffect", () => {
  it("collapses the same elevation to one key", () => {
    const geo = {
      type: "DROP_SHADOW",
      x: 3,
      y: 3,
      blur: 4,
      spread: 0,
      color: "#1A1A1A",
      opacity: 100,
      inset: false,
    };
    expect(fingerprintEffect(geo)).toBe("drop-shadow 3 3 4 0 #1a1a1a@100");
  });
});
