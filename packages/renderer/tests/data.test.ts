import { describe, expect, it } from "vitest";
import { interpolate, lookup } from "../src/resolve/data.js";

const data = {
  player: {
    name: "SOPHIE\nMOLINEUX",
    cutout: "https://www.southernbrave.com/static-assets/images/players/67041.png?v=1.14&w=285",
    stats: { matches: "6", wickets: "10", economy: "5.5" },
  },
};

describe("interpolate", () => {
  it("resolves nested paths", () => {
    expect(interpolate("{player.stats.wickets}", data).value).toBe("10");
    expect(interpolate("{player.name}", data).value).toBe("SOPHIE\nMOLINEUX");
  });

  it("leaves unresolved paths as literals and reports them", () => {
    const r = interpolate("{player.stats.average}", data);
    expect(r.value).toBe("{player.stats.average}");
    expect(r.unresolved).toEqual(["player.stats.average"]);
  });

  it("never renders the string undefined", () => {
    const r = interpolate("hi {missing}", {});
    expect(r.value).not.toContain("undefined");
    expect(r.value).toBe("hi {missing}");
  });

  it("passes through templates with no tokens", () => {
    expect(interpolate("BOWLER", data)).toEqual({ value: "BOWLER", unresolved: [] });
  });
});

describe("lookup", () => {
  it("walks dotted paths", () => {
    expect(lookup(data, "player.stats.economy")).toBe("5.5");
  });

  it("returns undefined for missing segments", () => {
    expect(lookup(data, "player.nope")).toBeUndefined();
  });
});
