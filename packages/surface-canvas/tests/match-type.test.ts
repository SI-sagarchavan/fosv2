import { describe, expect, it } from "vitest";
import { inferBreakpoint, matchType, resolveWeight } from "../src/match/type.js";
import { themeSnapshot } from "./health-fixtures.js";

const types = themeSnapshot().types;

describe("resolveWeight", () => {
  it("maps Figma's style names onto the theme's numbers", () => {
    expect(resolveWeight("Bold")).toBe(700);
    expect(resolveWeight("SemiBold")).toBe(600);
    expect(resolveWeight("Semi Bold")).toBe(600);
    expect(resolveWeight("Regular")).toBe(400);
    // Italic is a face, not a weight.
    expect(resolveWeight("Bold Italic")).toBe(700);
  });

  it("passes numbers through and gives up on nonsense", () => {
    expect(resolveWeight(500)).toBe(500);
    expect(resolveWeight("Chonky")).toBeUndefined();
  });
});

describe("inferBreakpoint", () => {
  it("reads the breakpoint off the frame width", () => {
    expect(inferBreakpoint(390)).toBe("mobile");
    expect(inferBreakpoint(834)).toBe("tablet");
    expect(inferBreakpoint(1366)).toBe("desktop");
  });
});

describe("matchType", () => {
  const h1 = { fontFamily: "Montserrat", fontSize: 20, fontWeight: 700, lineHeight: 28 };

  it("matches the full quadruple at the current breakpoint", () => {
    const match = matchType(h1, types, "desktop")!;
    expect(match.kind).toBe("exact");
    expect(match.winner.ref).toBe("type.h1_bold");
  });

  it("accepts a Figma style name for the weight", () => {
    expect(matchType({ ...h1, fontWeight: "Bold" }, types, "desktop")!.winner.ref).toBe(
      "type.h1_bold",
    );
  });

  it("refuses when any one of the four disagrees", () => {
    expect(matchType({ ...h1, fontSize: 21 }, types, "desktop")).toBeNull();
    expect(matchType({ ...h1, lineHeight: 30 }, types, "desktop")).toBeNull();
    expect(matchType({ ...h1, fontWeight: 600 }, types, "desktop")).toBeNull();
    expect(matchType({ ...h1, fontFamily: "Inter" }, types, "desktop")).toBeNull();
  });

  it("refuses an auto line height rather than guessing the font's metrics", () => {
    expect(matchType({ ...h1, lineHeight: "auto" }, types, "desktop")).toBeNull();
  });

  it("checks the breakpoint it was given, not whichever one matches", () => {
    // The mobile entry for the same token has its own metrics. Checked at
    // "mobile", those metrics match; the desktop quadruple must not.
    const entry = types.find((t) => t.ref === "type.h1_bold")!;
    const mobile = entry.byBreakpoint.mobile!;
    const desktop = entry.byBreakpoint.desktop!;

    expect(
      matchType(
        {
          fontFamily: mobile.family,
          fontSize: mobile.size,
          fontWeight: mobile.weight,
          lineHeight: mobile.lineHeight,
        },
        types,
        "mobile",
      )!.winner.ref,
    ).toBe("type.h1_bold");

    if (mobile.size !== desktop.size || mobile.lineHeight !== desktop.lineHeight) {
      expect(matchType(h1, types, "mobile")).toBeNull();
    }
  });
});
