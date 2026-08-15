import { describe, expect, it } from "vitest";
import {
  appendLane,
  firstName,
  initialOf,
  laneKey,
  mergeActivity,
  parseLane,
  popLane,
  recentActors,
  samePerson,
  type ActivityActor,
  type ActivityEntry,
} from "../src/health/activity.js";

const priya: ActivityActor = { id: "u1", name: "Priya Shah", color: "#e10a15" };
const amit: ActivityActor = { id: "u2", name: "Amit Rao", color: "#2939a3" };

function entry(
  actor: ActivityActor,
  id: string,
  at: number,
  label = "fill #ffffff",
): ActivityEntry {
  return { id, actor, kind: "bind", label, tokenRef: "color.core_neu_00", applied: 10, at };
}

describe("people", () => {
  it("chips the first name and initial, never the full change line", () => {
    expect(firstName("Priya Shah")).toBe("Priya");
    expect(initialOf("Priya Shah")).toBe("P");
  });

  it("matches on id when both have one", () => {
    expect(samePerson(priya, { ...priya, name: "P. Shah" })).toBe(true);
    expect(samePerson(priya, amit)).toBe(false);
  });
});

describe("lanes", () => {
  it("writes each designer to their own key so two binds cannot clobber", () => {
    expect(laneKey("u1")).toBe("fanos-studio.act.u1");
    expect(laneKey("u2")).toBe("fanos-studio.act.u2");
    expect(laneKey(null)).toBe("fanos-studio.act.anon");
  });

  it("merges two lanes newest first and drops duplicate ids", () => {
    const a = [entry(priya, "a", 100), entry(priya, "shared", 50)];
    const b = [entry(amit, "b", 80), entry(amit, "shared", 50)];
    expect(mergeActivity([a, b]).map((item) => item.id)).toEqual(["a", "b", "shared"]);
  });

  it("appends onto one lane without touching the other", () => {
    const mine = appendLane([entry(priya, "old", 1)], entry(priya, "new", 2));
    expect(mine.map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("pops the matching id on undo, or the newest if none is named", () => {
    const lane = [entry(priya, "new", 2), entry(priya, "old", 1)];
    expect(popLane(lane, "new").map((item) => item.id)).toEqual(["old"]);
    expect(popLane(lane).map((item) => item.id)).toEqual(["old"]);
  });
});

describe("recentActors", () => {
  it("lists distinct people inside the window, newest first", () => {
    const now = 10_000;
    const entries = [
      entry(priya, "p1", now - 100),
      entry(amit, "a1", now - 200),
      entry(priya, "p0", now - 300),
    ];
    expect(recentActors(entries, now).map((actor) => actor.name)).toEqual([
      "Priya Shah",
      "Amit Rao",
    ]);
  });

  it("drops people whose last bind is older than the window", () => {
    const now = 10_000;
    const entries = [entry(amit, "old", now - 3 * 60 * 60 * 1000)];
    expect(recentActors(entries, now)).toEqual([]);
  });
});

describe("parseLane", () => {
  it("returns nothing for junk so a corrupt key cannot take down the panel", () => {
    expect(parseLane("")).toEqual([]);
    expect(parseLane("nope")).toEqual([]);
    expect(parseLane('{"id":1}')).toEqual([]);
  });

  it("round-trips a valid lane", () => {
    const lane = [entry(priya, "a", 1)];
    expect(parseLane(JSON.stringify(lane))).toEqual(lane);
  });
});
