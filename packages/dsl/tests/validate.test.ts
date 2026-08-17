/**
 * Every rule, plus the acceptance mutations: change one thing on the real card
 * and assert the RIGHT error comes back — not merely that something failed.
 */

import { describe, expect, it } from "vitest";
import { issuesByCode, validate } from "../src/validate.js";
import { card, nodeOf, registry, tinyTree } from "./helpers.js";

function check(tree: ReturnType<typeof card>) {
  return validate(tree, { registry: registry() });
}

describe("the card fixture", () => {
  it("validates with zero errors", () => {
    const result = check(card());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("S1 — the tree must fold up", () => {
  it("reports a reify failure once, with the offending node", () => {
    const tree = card();
    nodeOf(tree, "role").parent = "ghost";
    const [issue] = issuesByCode(check(tree), "S1");
    expect(issue?.message).toContain("ghost");
  });
});

describe("S2 — unknown node type", () => {
  it("names the type", () => {
    const tree = card();
    nodeOf(tree, "role").type = "Marquee";
    const [issue] = issuesByCode(check(tree), "S2");
    expect(issue?.message).toContain("Marquee");
  });
});

describe("S3 — identity", () => {
  it("rejects a duplicate id", () => {
    const tree = card();
    nodeOf(tree, "role").id = "cutout";
    expect(issuesByCode(check(tree), "S3").some((i) => i.message.includes("duplicate"))).toBe(true);
  });

  it("rejects a missing src — every node needs a Figma origin for the repair loop", () => {
    const tree = card();
    nodeOf(tree, "role").src = "";
    expect(issuesByCode(check(tree), "S3").some((i) => i.message.includes("missing src"))).toBe(true);
  });
});

describe("S4 — Section placement", () => {
  it("rejects a Section that is not a direct child of the root", () => {
    const tree = tinyTree([
      { id: "root", parent: null, idx: 0, type: "Box", src: "1:1", props: {} },
      { id: "mid", parent: "root", idx: 0, type: "Box", src: "1:2", props: {} },
      { id: "sec", parent: "mid", idx: 0, type: "Section", src: "1:3", props: { width: "content" } },
    ]);
    expect(issuesByCode(check(tree), "S4")).toHaveLength(1);
  });

  it("accepts one directly under the root", () => {
    const tree = tinyTree([
      { id: "root", parent: null, idx: 0, type: "Box", src: "1:1", props: {} },
      { id: "sec", parent: "root", idx: 0, type: "Section", src: "1:2", props: { width: "content" } },
    ]);
    expect(issuesByCode(check(tree), "S4")).toEqual([]);
  });
});

describe("S5 — Repeater is a fragment", () => {
  const repeaterWith = (props: Record<string, unknown>) =>
    tinyTree([
      { id: "root", parent: null, idx: 0, type: "Stack", src: "1:1", props: {} },
      { id: "rep", parent: "root", idx: 0, type: "Repeater", src: "1:2", props: { over: "players", as: "player", ...props } },
    ]);

  it("rejects a layout prop", () => {
    const [issue] = issuesByCode(check(repeaterWith({ gap: "space.4" })), "S5");
    expect(issue?.path).toBe("gap");
    expect(issue?.message).toContain("fragment");
  });

  it("rejects space, size, surface and place", () => {
    for (const [prop, value] of [
      ["space", { p: "space.4" }],
      ["size", { w: "full" }],
      ["surface", "surface.card_player"],
      ["place", { anchor: "center" }],
    ] as const) {
      expect(issuesByCode(check(repeaterWith({ [prop]: value })), "S5"), prop).toHaveLength(1);
    }
  });

  it("accepts a bare Repeater", () => {
    expect(check(repeaterWith({})).errors).toEqual([]);
  });
});

describe("S6 / S7 — place belongs to the child, checked against the parent", () => {
  /**
   * A Stack positions the children that opt OUT of its flow. Figma does this —
   * an absolutely-positioned child of an auto-layout frame — and CSS renders it
   * as `position: absolute` inside a `position: relative` box. Forbidding it
   * forced the compiler to demote the whole frame to an Overlay, which anchors
   * every sibling and discards the row.
   */
  it("accepts place.anchor under a Stack — a child may opt out of the flow", () => {
    const tree = card();
    // `stat_matches_label` sits under `stat_matches`, a Stack.
    nodeOf(tree, "stat_matches_label").props["place"] = { anchor: "center" };
    expect(issuesByCode(check(tree), "S6")).toHaveLength(0);
  });

  it("still rejects place.anchor under a parent that cannot position it", () => {
    const tree = tinyTree([
      { id: "b", parent: null, idx: 0, type: "Box", src: "1:1", props: {} },
      { id: "c", parent: "b", idx: 0, type: "Box", src: "1:2", props: { place: { anchor: "center" } } },
    ]);
    const [issue] = issuesByCode(check(tree), "S6");
    expect(issue?.nodeId).toBe("c");
    expect(issue?.message).toContain("Box");
  });

  it("rejects place.span when the parent is not a Grid", () => {
    const tree = card();
    nodeOf(tree, "stat_matches_label").props["place"] = { span: 2 };
    expect(issuesByCode(check(tree), "S7")).toHaveLength(1);
  });

  it("accepts place.span under a Grid", () => {
    const tree = tinyTree([
      { id: "g", parent: null, idx: 0, type: "Grid", src: "1:1", props: { columns: 3 } },
      { id: "c", parent: "g", idx: 0, type: "Box", src: "1:2", props: { place: { span: 2 } } },
    ]);
    expect(check(tree).errors).toEqual([]);
  });
});

describe("S8 — Overlay children must declare where they go", () => {
  it("rejects a child with no anchor", () => {
    const tree = card();
    delete nodeOf(tree, "cutout").props["place"];
    const [issue] = issuesByCode(check(tree), "S8");
    expect(issue?.nodeId).toBe("cutout");
  });

  it("does NOT flag duplicate anchors between siblings — that is how layering works", () => {
    // The IR card has two top-center children: the cutout and the name.
    const tree = card();
    const anchors = tree.nodes
      .filter((n) => n.parent === "card")
      .map((n) => (n.props["place"] as { anchor?: string } | undefined)?.anchor);
    // card_bg, cutout and name all anchor top-center.
    expect(anchors.filter((a) => a === "top-center")).toHaveLength(3);
    expect(check(tree).errors).toEqual([]);
  });
});

describe("S9 — Grid auto columns", () => {
  const grid = (props: Record<string, unknown>) =>
    tinyTree([{ id: "g", parent: null, idx: 0, type: "Grid", src: "1:1", props }]);

  it("rejects columns:\"auto\" with no minItemWidth", () => {
    expect(issuesByCode(check(grid({ columns: "auto" })), "S9")).toHaveLength(1);
  });

  it("accepts it once minItemWidth is present", () => {
    expect(issuesByCode(check(grid({ columns: "auto", minItemWidth: "space.16" })), "S9")).toEqual([]);
  });

  it("catches \"auto\" hiding inside a responsive wrapper", () => {
    expect(issuesByCode(check(grid({ columns: { base: 2, lg: "auto" } })), "S9")).toHaveLength(1);
  });
});

describe("S10 — Carousel chrome (warning, heuristic)", () => {
  it("warns rather than errors, because it is a guess", () => {
    const tree = tinyTree([
      {
        id: "c",
        parent: null,
        idx: 0,
        type: "Carousel",
        src: "1:1",
        props: {
          slidesPerView: 3,
          snap: "start",
          loop: false,
          autoplay: false,
          controls: ["arrows"],
          controlsPlacement: "edge",
        },
      },
      { id: "arrow", parent: "c", idx: 0, type: "Icon", src: "1:2-arrow-right", props: { name: "chevron" } },
    ]);
    const result = check(tree);
    expect(result.errors).toEqual([]);
    expect(issuesByCode(result, "S10")).toHaveLength(1);
    expect(result.ok).toBe(true);
  });
});

describe("S11 — Custom.ref", () => {
  const custom = (ref: unknown) =>
    tinyTree([{ id: "x", parent: null, idx: 0, type: "Custom", src: "1:1", props: { ref, props: {} } }]);

  it("rejects a ref without a version", () => {
    expect(issuesByCode(check(custom("player-card")), "S11")).toHaveLength(1);
  });

  it("accepts name@semver", () => {
    expect(issuesByCode(check(custom("player-card@1.2.3")), "S11")).toEqual([]);
  });
});

describe("T1 — unresolvable token refs", () => {
  it("names the ref, the node, the path and up to three near misses", () => {
    const tree = card();
    nodeOf(tree, "card").props["surface"] = "surface.nope";
    const [issue] = issuesByCode(check(tree), "T1");
    expect(issue?.nodeId).toBe("card");
    expect(issue?.path).toBe("surface");
    expect(issue?.message).toContain("surface.nope");
    expect(issue?.suggestions).toContain("surface.card_player");
    expect(issue?.suggestions?.length).toBeLessThanOrEqual(3);
  });

  it("catches an out-of-range spacing step", () => {
    const tree = card();
    nodeOf(tree, "stats").props["gap"] = "space.99";
    const [issue] = issuesByCode(check(tree), "T1");
    expect(issue?.message).toContain("space.99");
    expect(issue?.suggestions?.every((s) => s.startsWith("space."))).toBe(true);
  });

  it("accepts space.7, which this theme really does have", () => {
    // The scale runs 0-16 plus half-steps; nothing stops at 6.
    const tree = card();
    nodeOf(tree, "stats").props["gap"] = "space.7";
    expect(issuesByCode(check(tree), "T1")).toEqual([]);
  });

  it("resolves a negated offset ref", () => {
    const tree = card();
    expect(check(tree).errors).toEqual([]);
    (nodeOf(tree, "badges").props["place"] as { offset: Record<string, string> }).offset["inline"] = "-space.99";
    expect(issuesByCode(check(tree), "T1")).toHaveLength(1);
  });
});

describe("T2 — Text.style must be a type token", () => {
  it("rejects a colour ref", () => {
    const tree = card();
    nodeOf(tree, "name").props["style"] = "color.core_neu_00";
    const [issue] = issuesByCode(check(tree), "T2");
    expect(issue?.nodeId).toBe("name");
    expect(issue?.path).toBe("style");
    expect(issue?.message).toContain("TypeToken");
  });

  it("reports T2 and not a generic shape error", () => {
    const tree = card();
    nodeOf(tree, "name").props["style"] = "color.core_neu_00";
    expect(issuesByCode(check(tree), "S12")).toEqual([]);
  });
});

describe("T3 — type tokens are already responsive", () => {
  it("rejects a Resp wrapper around Text.style", () => {
    const tree = card();
    nodeOf(tree, "name").props["style"] = { base: "type.dp_2_regular", md: "type.dp_1_regular" };
    const [issue] = issuesByCode(check(tree), "T3");
    expect(issue?.nodeId).toBe("name");
    expect(issue?.message).toContain("ALREADY responsive");
  });

  it("does not also emit a shape error for the same value", () => {
    const tree = card();
    nodeOf(tree, "name").props["style"] = { base: "type.dp_2_regular", md: "type.dp_1_regular" };
    expect(issuesByCode(check(tree), "S12")).toEqual([]);
  });
});

describe("T4 — breakpoint keys come from the tokens package", () => {
  it("rejects a key the tokens config does not define", () => {
    const tree = card();
    nodeOf(tree, "stats").props["gap"] = { base: "space.5", xl: "space.6" };
    const [issue] = issuesByCode(check(tree), "T4");
    expect(issue?.message).toContain("xl");
    expect(issue?.message).toContain("md, lg");
  });

  it("accepts md and lg", () => {
    const tree = card();
    nodeOf(tree, "stats").props["gap"] = { base: "space.5", md: "space.6", lg: "space.6" };
    expect(check(tree).errors).toEqual([]);
  });
});

describe("T5 — right shape, wrong category", () => {
  it("rejects a colour token where a space token belongs", () => {
    const tree = card();
    nodeOf(tree, "stats").props["gap"] = "color.core_neu_00";
    const [issue] = issuesByCode(check(tree), "T5");
    expect(issue?.message).toContain("takes a space token");
    expect(issue?.message).toContain("color");
  });
});

describe("metrics", () => {
  it("counts the IR's absolute geometry as raw", () => {
    // The tree carries the Figma frame's absolute px, which is correct for a
    // fixed-aspect card the renderer scales as a whole (see designWidth).
    //
    // Worth knowing when reading this number: for such a card the absolute
    // geometry IS the design, not debt — the metric cannot tell the two apart.
    //
    // Counted against an INDEPENDENT walk of the fixture rather than a literal,
    // so editing the card to match Figma more closely does not fail a test that
    // has nothing to do with the edit. Every `_unbound` marker must land in
    // exactly one bucket, and the buckets must sum to the total.
    const m = check(card()).metrics;
    const unbound = JSON.stringify(card()).match(/"_unbound":true/g)?.length ?? 0;
    expect(unbound).toBeGreaterThan(0);
    expect(m.rawValueCount.total).toBe(unbound);
    const { total, ...buckets } = m.rawValueCount;
    expect(Object.values(buckets).reduce((a, b) => a + b, 0)).toBe(total);
    // Colour is fully tokenised on this card; the debt is geometry.
    expect(m.rawValueCount.color).toBe(0);
    expect(m.rawValueCount.space).toBeGreaterThan(0);
    expect(m.rawValueCount.size).toBeGreaterThan(0);
    // Anchored offsets are counted separately from sizes and gaps.
    expect(m.rawPositionCount).toBe(6);
  });

  it("counts nodes, depth, synthetic and custom", () => {
    const tree = card();
    const m = check(tree).metrics;
    expect(m.nodeCount).toBe(tree.nodes.length);
    expect(m.maxDepth).toBe(3);
    expect(m.syntheticNodeCount).toBe(0);
    expect(m.customNodeCount).toBe(0);
  });

  it("reports token coverage over values that could actually be a token", () => {
    const m = check(card()).metrics;
    const tokenisable = m.rawValueCount.total - m.rawPositionCount;
    expect(m.tokenCoverage).toBeCloseTo(
      m.tokenisedValueCount / (m.tokenisedValueCount + tokenisable),
      4,
    );
    expect(m.tokenisedValueCount).toBeGreaterThan(25);
  });

  /**
   * A coordinate has no token to bind to, so counting it caps the ratio below
   * 1 forever — the metric would measure how many Overlays a design has, not
   * how well it is tokenised. On the fixtures page 954 of 1496 raws were
   * coordinates, reporting 27% for a tree that was genuinely at 51%.
   */
  it("excludes position from coverage, and reports it undiluted instead", () => {
    const tree = card();
    const before = check(tree).metrics;

    // Pin one more node by hand: pure position debt, no token was possible.
    const node = nodeOf(tree, "stat_matches_label");
    node.props["place"] = {
      anchor: "top-start",
      offset: { block: { raw: 12, _unbound: true }, inline: { raw: 34, _unbound: true } },
    };
    const after = check(tree).metrics;

    expect(after.rawPositionCount).toBe(before.rawPositionCount + 2);
    expect(after.rawValueCount.total).toBe(before.rawValueCount.total + 2);
    // The thing that matters: coverage did not fall because of it.
    expect(after.tokenCoverage).toBeCloseTo(before.tokenCoverage, 4);
  });

  it("does NOT count percentages as raw debt — they are relative and re-theme correctly", () => {
    // The IR-derived card uses absolute px throughout, so it has none; a
    // percentage still must not be counted as raw when one appears.
    // The IR card is all absolute px, so it has none; a percentage still must
    // not be counted as raw when one appears.
    const base = check(card()).metrics;
    const tree = card();
    (nodeOf(tree, "cutout").props["size"] as Record<string, unknown>)["h"] = "91%";
    const m = check(tree).metrics;
    // A delta, not an absolute: the card already carries relative sizes of its
    // own (`"full"` where the IR says fill), and this test is about the ONE
    // value it just changed.
    expect(m.relativeValueCount).toBe(base.relativeValueCount + 1);
    // The raw it replaced is gone from the size bucket and NOT re-counted
    // anywhere else — a percentage re-themes correctly, so it is not debt.
    expect(m.rawValueCount.size).toBe(base.rawValueCount.size - 1);
    expect(m.rawValueCount.total).toBe(base.rawValueCount.total - 1);
  });

  it("still reports metrics for a tree that fails validation", () => {
    const base = check(card()).metrics;
    const tree = card();
    nodeOf(tree, "card").props["surface"] = "surface.nope";
    const result = check(tree);
    expect(result.ok).toBe(false);
    expect(result.metrics.rawValueCount.total).toBe(base.rawValueCount.total);
  });

  it("buckets duration raws separately from size raws", () => {
    const base = check(card()).metrics;
    const tree = card();
    nodeOf(tree, "name").props["revealDelay"] = { raw: 200, _unbound: true };
    const m = check(tree).metrics;
    expect(m.rawValueCount.duration).toBe(base.rawValueCount.duration + 1);
    // A duration raw must not leak into the geometry buckets.
    expect(m.rawValueCount.size).toBe(base.rawValueCount.size);
    expect(m.rawValueCount.space).toBe(base.rawValueCount.space);
    expect(m.rawValueCount.total).toBe(base.rawValueCount.total + 1);
  });
});
