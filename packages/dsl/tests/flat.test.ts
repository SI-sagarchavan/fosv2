import { describe, expect, it } from "vitest";
import { flatten, isSynthetic, reify, ReifyError, syntheticSrc, type FlatTree } from "../src/flat.js";
import { card, tinyTree } from "./helpers.js";

const leaf = (id: string, parent: string | null, idx: number) => ({
  id,
  parent,
  idx,
  type: "Box",
  src: `1:${id}`,
  props: {},
});

describe("flatten / reify round-trip", () => {
  it("flatten(reify(flat)) is deep-equal to flat for the card fixture", () => {
    const flat = card();
    expect(flatten(reify(flat))).toEqual(flat);
  });

  it("preserves depth-first pre-order", () => {
    const flat = card();
    expect(flatten(reify(flat)).nodes.map((n) => n.id)).toEqual(flat.nodes.map((n) => n.id));
  });

  it("carries props through untouched", () => {
    const flat = card();
    const before = flat.nodes.find((n) => n.id === "role")!.props;
    const after = flatten(reify(flat)).nodes.find((n) => n.id === "role")!.props;
    expect(after).toEqual(before);
  });

  it("keeps the schemaVersion", () => {
    expect(flatten(reify(card())).schemaVersion).toBe("1.0.0");
  });
});

describe("reify rules", () => {
  it("accepts exactly one root", () => {
    expect(() => reify(tinyTree([leaf("a", null, 0)]))).not.toThrow();
  });

  it("rejects two roots", () => {
    const error = grab(() => reify(tinyTree([leaf("a", null, 0), leaf("b", null, 0)])));
    expect(error.code).toBe("multi-root");
  });

  it("rejects no root", () => {
    const error = grab(() => reify(tinyTree([leaf("a", "b", 0), leaf("b", "a", 0)])));
    expect(error.code).toBe("no-root");
  });

  it("rejects an orphan", () => {
    const error = grab(() => reify(tinyTree([leaf("a", null, 0), leaf("b", "ghost", 0)])));
    expect(error.code).toBe("orphan");
    expect(error.message).toContain("ghost");
  });

  it("rejects a duplicate id", () => {
    const error = grab(() => reify(tinyTree([leaf("a", null, 0), leaf("a", "a", 0)])));
    expect(error.code).toBe("duplicate-id");
  });

  it("rejects a self-parent", () => {
    const error = grab(() => reify(tinyTree([leaf("a", null, 0), leaf("b", "b", 0)])));
    expect(error.code).toBe("self-parent");
  });

  it("rejects a cycle detached from the root", () => {
    const error = grab(() =>
      reify(tinyTree([leaf("a", null, 0), leaf("b", "c", 0), leaf("c", "b", 0)])),
    );
    expect(error.code).toBe("cycle");
  });

  it("rejects an idx gap rather than silently compacting it", () => {
    // A gap means the producer dropped a node it thought it emitted. Compacting
    // would hide that and ship a tree missing a child nobody noticed.
    const error = grab(() => reify(tinyTree([leaf("a", null, 0), leaf("b", "a", 0), leaf("c", "a", 2)])));
    expect(error.code).toBe("idx-gap");
    expect(error.message).toContain("contiguous");
  });

  it("sorts children by idx regardless of array order", () => {
    const tree = tinyTree([leaf("a", null, 0), leaf("second", "a", 1), leaf("first", "a", 0)]);
    expect(reify(tree).children?.map((c) => c.id)).toEqual(["first", "second"]);
  });

  it("omits `children` on a leaf rather than emitting an empty array", () => {
    expect(reify(tinyTree([leaf("a", null, 0)]))).toEqual({ id: "a", type: "Box", src: "1:a", props: {} });
  });
});

describe("synthetic src", () => {
  it("names the parent it was inserted under", () => {
    expect(syntheticSrc("1:5009", 0)).toBe("synthetic:1:5009:0");
    expect(isSynthetic(syntheticSrc("1:5009", 0))).toBe(true);
    expect(isSynthetic("1:5009")).toBe(false);
  });
});

function grab(run: () => unknown): ReifyError {
  try {
    run();
  } catch (error) {
    if (error instanceof ReifyError) return error;
    throw error;
  }
  throw new Error("expected reify to throw");
}

describe("fixture shape", () => {
  it("is authored in the order flatten produces, so the round-trip is exact", () => {
    const flat: FlatTree = card();
    const seen = new Set<string>();
    for (const node of flat.nodes) {
      if (node.parent !== null) expect(seen.has(node.parent)).toBe(true);
      seen.add(node.id);
    }
  });
});
