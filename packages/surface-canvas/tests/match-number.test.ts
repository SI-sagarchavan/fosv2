import { describe, expect, it } from "vitest";
import { isSubpixel, matchNumber, numberEvidence } from "../src/match/number.js";
import { themeSnapshot } from "./health-fixtures.js";

const snapshot = themeSnapshot();
const opts = { nearWithin: 2, maxCandidates: 3 };

describe("matchNumber", () => {
  it("matches the spacing scale exactly", () => {
    const match = matchNumber(10, snapshot.spaces, opts)!;
    expect(match.kind).toBe("exact");
    expect(match.winner.ref).toBe("space.2_5");
    expect(numberEvidence(10, match)).toBe("10px === space.2_5");
  });

  it("matches 16 to space.4 and 0 to radius.none", () => {
    expect(matchNumber(16, snapshot.spaces, opts)!.winner.ref).toBe("space.4");
    expect(matchNumber(0, snapshot.radii, opts)!.winner.ref).toBe("radius.none");
  });

  it("near-matches within the window, ranked closest first", () => {
    const match = matchNumber(13, snapshot.spaces, opts)!;
    expect(match.kind).toBe("near");
    expect(match.winner.px).toBe(12);
    expect(numberEvidence(13, match)).toBe("13px, nearest is space.3 (12)");
    expect(match.candidates[0]!.distance).toBeLessThanOrEqual(match.candidates[1]!.distance);
  });

  it("proposes nothing beyond the window", () => {
    // 27 is not a mis-typed 24. It is a decision nobody has made.
    expect(matchNumber(27, snapshot.radii, opts)).toBeNull();
  });

  it("is deterministic when two tokens share a value", () => {
    const first = matchNumber(16, snapshot.spaces, opts)!.winner.ref;
    for (let i = 0; i < 5; i++) {
      expect(matchNumber(16, snapshot.spaces, opts)!.winner.ref).toBe(first);
    }
  });
});

describe("isSubpixel", () => {
  it("flags the values the reference file actually contains", () => {
    for (const value of [10.4, 12.678, 13.209, 13.481, 13.487, 14.83, 20.23, 21.818]) {
      expect(isSubpixel(value)).toBe(true);
    }
  });

  it("leaves whole numbers alone", () => {
    for (const value of [0, 4, 10, 16, 999]) expect(isSubpixel(value)).toBe(false);
  });
});
