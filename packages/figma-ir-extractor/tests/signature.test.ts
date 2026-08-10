import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  SIGNATURE_DEPTH_LIMIT,
  annotateTree,
  assignRepeatedSiblings,
  computeCanonicalSignature,
  computeStructuralSignature,
  describeCanonicalShape,
  describeShape,
} from "../src/ir/signature";
import {
  deepChain,
  fixtureCard,
  matchCard,
  node,
  playerCard,
  textNode,
} from "./fixtures";

/** The five real player cards, differing only in badge count and width. */
const FIVE_CARDS = () => [
  playerCard({ name: "Ben McKinney", badges: 1, width: 281 }),
  playerCard({ name: "Jofra Archer", badges: 2, width: 281 }),
  playerCard({ name: "Craig Overton", badges: 0, width: 281 }),
  playerCard({ name: "James Vince", badges: 1, width: 281 }),
  playerCard({ name: "Chris Jordan", badges: 0, width: 281 }),
];

describe("describeShape", () => {
  it("encodes shape only", () => {
    const card = matchCard({ team: "Mumbai", score: "182/4", fill: "#ff0000", width: 300 });
    // The card hugs vertically, so its own aspect is content-driven and drops out.
    expect(describeShape(card)).toBe("INSTANCE:vertical:fillhug:2:hug");
  });

  it("leaks nothing about content", () => {
    const card = matchCard({ team: "Chennai", score: "77/9", fill: "#0000ff", width: 512 });
    const shape = describeShape(card);
    for (const secret of ["Chennai", "77/9", "#0000ff", "512", card.id, card.name]) {
      expect(shape).not.toContain(secret);
    }
  });
});

describe("computeStructuralSignature", () => {
  it("is identical for two instances of the same card with different content", () => {
    const a = matchCard({ team: "Mumbai Indians", score: "182/4", fill: "#0b1e3f", width: 320 });
    const b = matchCard({ team: "RCB", score: "77/9 (14.2)", fill: "#e2231a", width: 511 });

    expect(computeStructuralSignature(a)).toBe(computeStructuralSignature(b));
  });

  it("differs when the shape differs", () => {
    const card = matchCard({ team: "A", score: "1", fill: "#000", width: 300 });
    const withExtraChild = matchCard({ team: "A", score: "1", fill: "#000", width: 300 });
    withExtraChild.children.push(textNode("Live"));

    expect(computeStructuralSignature(card)).not.toBe(
      computeStructuralSignature(withExtraChild),
    );
  });

  it("differs when layout direction flips", () => {
    const vertical = node({ mode: "vertical", children: [textNode("x")] });
    const horizontal = node({ mode: "horizontal", children: [textNode("x")] });

    expect(computeStructuralSignature(vertical)).not.toBe(
      computeStructuralSignature(horizontal),
    );
  });

  it("differs when sizing differs", () => {
    const base = node({ sizing: { w: "fill", h: "hug" }, aspectBucket: "square" });
    const otherSizing = node({ sizing: { w: "fixed", h: "hug" }, aspectBucket: "square" });

    expect(computeStructuralSignature(base)).not.toBe(
      computeStructuralSignature(otherSizing),
    );
  });

  it("differs when the aspect bucket of a fixed-size node differs", () => {
    const base = node({ sizing: { w: "fixed", h: "fixed" }, aspectBucket: "square" });
    const wide = node({ sizing: { w: "fixed", h: "fixed" }, aspectBucket: "wide" });

    expect(computeStructuralSignature(base)).not.toBe(computeStructuralSignature(wide));
  });

  it("ignores the aspect bucket of content-sized nodes", () => {
    // Regression: a hug-sized text node's aspect tracks its own characters, so
    // "116.67" and "300" bucketed differently and split one component's
    // instances into five signature groups on a real page.
    const short = node({ sizing: { w: "hug", h: "hug" }, aspectBucket: "landscape" });
    const long = node({ sizing: { w: "hug", h: "hug" }, aspectBucket: "ultrawide" });

    expect(computeStructuralSignature(short)).toBe(computeStructuralSignature(long));
  });

  it("still separates a hug node from a fixed node of the same aspect", () => {
    const hugging = node({ sizing: { w: "hug", h: "hug" }, aspectBucket: "wide" });
    const fixed = node({ sizing: { w: "fixed", h: "fixed" }, aspectBucket: "wide" });

    expect(computeStructuralSignature(hugging)).not.toBe(
      computeStructuralSignature(fixed),
    );
  });

  it("ignores content-driven aspect deep inside a card", () => {
    const withShortStat = matchCard({ team: "MI", score: "1", fill: "#000", width: 300 });
    const withLongStat = matchCard({ team: "MI", score: "116.67", fill: "#000", width: 300 });
    // Simulate hug text measuring differently because of its own characters.
    withLongStat.children[1]!.children[1]!.geometry.aspectBucket = "ultrawide";

    expect(computeStructuralSignature(withShortStat)).toBe(
      computeStructuralSignature(withLongStat),
    );
  });

  it("ignores differences deeper than the depth limit", () => {
    const shallow = deepChain(SIGNATURE_DEPTH_LIMIT + 2);
    const divergent = deepChain(SIGNATURE_DEPTH_LIMIT + 2);

    // Mutate a node below the depth limit relative to the root.
    let cursor = divergent;
    for (let i = 0; i < SIGNATURE_DEPTH_LIMIT + 1; i++) cursor = cursor.children[0]!;
    cursor.geometry.aspectBucket = "ultrawide";

    expect(computeStructuralSignature(shallow)).toBe(
      computeStructuralSignature(divergent),
    );
  });

  it("notices differences at exactly the depth limit", () => {
    const base = deepChain(SIGNATURE_DEPTH_LIMIT + 2);
    const divergent = deepChain(SIGNATURE_DEPTH_LIMIT + 2);

    let cursor = divergent;
    for (let i = 0; i < SIGNATURE_DEPTH_LIMIT; i++) cursor = cursor.children[0]!;
    cursor.geometry.aspectBucket = "ultrawide";

    expect(computeStructuralSignature(base)).not.toBe(
      computeStructuralSignature(divergent),
    );
  });

  it("is stable across repeated calls", () => {
    const card = matchCard({ team: "A", score: "1", fill: "#000", width: 300 });
    expect(computeStructuralSignature(card)).toBe(computeStructuralSignature(card));
  });
});

describe("canonical signature — the 5-collapse / 2-split criterion", () => {
  it("collapses five instances of one component into one group", () => {
    const groups = new Set(FIVE_CARDS().map((c) => computeCanonicalSignature(c)));
    expect(groups.size).toBe(1);
  });

  it("keeps the strict signature strict — the same five split", () => {
    // Not a defect: an optional badge really is a different exact shape.
    // This is why both signatures exist.
    const groups = new Set(FIVE_CARDS().map((c) => computeStructuralSignature(c)));
    expect(groups.size).toBeGreaterThan(1);
  });

  it("still splits two genuinely different fixture cards", () => {
    const cards = [fixtureCard("recent"), fixtureCard("upcoming"), fixtureCard("upcoming")];
    const groups = new Set(cards.map((c) => computeCanonicalSignature(c)));
    expect(groups.size).toBe(2);
  });

  it("reports 5 for a row of five cards that strict signatures would split", () => {
    const row = node({
      name: "Squad Row",
      mode: "horizontal",
      children: FIVE_CARDS(),
    });

    annotateTree(row);

    expect(row.children.map((c) => c.repeatedSiblings)).toEqual([5, 5, 5, 5, 5]);
    expect(new Set(row.children.map((c) => c.structuralSignature)).size).toBeGreaterThan(1);
  });

  it("does not merge a fixtures row into one run", () => {
    const row = node({
      name: "Fixtures",
      mode: "horizontal",
      children: [fixtureCard("recent"), fixtureCard("upcoming"), fixtureCard("recent")],
    });

    annotateTree(row);

    // recent, upcoming, recent — no two alike are adjacent.
    expect(row.children.map((c) => c.repeatedSiblings)).toEqual([1, 1, 1]);
  });

  it("drops only childCount from the descriptor", () => {
    const n = node({ mode: "vertical", sizing: { w: "fill", h: "hug" }, children: [textNode("a")] });
    expect(describeShape(n)).toBe("FRAME:vertical:fillhug:1:hug");
    expect(describeCanonicalShape(n)).toBe("FRAME:vertical:fillhug:hug");
  });

  it("is still content-blind", () => {
    const a = playerCard({ name: "Ben McKinney", badges: 1, width: 281 });
    const b = playerCard({ name: "X", badges: 1, width: 999 });
    expect(computeCanonicalSignature(a)).toBe(computeCanonicalSignature(b));
  });
});

describe("depth sensitivity", () => {
  it("reacts one level deeper than it folds", () => {
    // A strict signature folds 3 levels, but the descriptor sitting at depth 3
    // carries a childCount — so a change at depth 4 still moves it. The
    // canonical signature carries no count and folds one level, so it does not.
    // Measured on a real page: exactly two nodes shifted this way.
    const build = (extraLeaf: boolean) =>
      node({
        name: "root",
        children: [
          node({
            name: "d1",
            children: [
              node({
                name: "d2",
                children: [
                  node({
                    name: "d3",
                    children: extraLeaf
                      ? [textNode("a"), textNode("b")]
                      : [textNode("a")],
                  }),
                ],
              }),
            ],
          }),
        ],
      });

    const one = annotateTree(build(false));
    const two = annotateTree(build(true));

    expect(two.structuralSignature).not.toBe(one.structuralSignature);
    expect(two.canonicalSignature).toBe(one.canonicalSignature);
  });
});

describe("assignRepeatedSiblings", () => {
  it("reports 5 for a row of five match cards", () => {
    const row = node({
      name: "Fixtures Row",
      mode: "horizontal",
      children: [
        matchCard({ team: "MI", score: "182/4", fill: "#0b1e3f", width: 300 }),
        matchCard({ team: "CSK", score: "77/9", fill: "#fdb913", width: 301 }),
        matchCard({ team: "RCB", score: "201/3", fill: "#e2231a", width: 299 }),
        matchCard({ team: "KKR", score: "150/8", fill: "#3a225d", width: 300 }),
        matchCard({ team: "SRH", score: "99/10", fill: "#f26522", width: 302 }),
      ],
    });

    annotateTree(row);

    expect(row.children.map((c) => c.repeatedSiblings)).toEqual([5, 5, 5, 5, 5]);
  });

  it("only counts consecutive runs", () => {
    const siblings = ["a", "a", "b", "a", "a", "a"].map((sig) => ({
      structuralSignature: sig,
      repeatedSiblings: 1,
    }));

    assignRepeatedSiblings(siblings, (s) => s.structuralSignature);

    expect(siblings.map((s) => s.repeatedSiblings)).toEqual([2, 2, 1, 3, 3, 3]);
  });

  it("gives lone nodes 1", () => {
    const siblings = ["a", "b", "c"].map((sig) => ({
      structuralSignature: sig,
      repeatedSiblings: 1,
    }));

    assignRepeatedSiblings(siblings, (s) => s.structuralSignature);

    expect(siblings.map((s) => s.repeatedSiblings)).toEqual([1, 1, 1]);
  });

  it("handles an empty sibling list", () => {
    expect(() => assignRepeatedSiblings([], () => "")).not.toThrow();
  });
});

describe("annotateTree", () => {
  it("agrees with computeStructuralSignature for every node", () => {
    const page = node({
      name: "Home",
      mode: "vertical",
      children: [
        node({
          name: "Hero",
          mode: "vertical",
          children: [textNode("Match Centre"), textNode("Live now")],
        }),
        node({
          name: "Fixtures",
          mode: "horizontal",
          children: [
            matchCard({ team: "MI", score: "1", fill: "#000", width: 300 }),
            matchCard({ team: "CSK", score: "2", fill: "#fff", width: 300 }),
          ],
        }),
      ],
    });

    // Snapshot the expected values before annotateTree mutates the tree.
    const expected = new Map<string, string>();
    walk(page, (n) => expected.set(n.id, computeStructuralSignature(n)));

    annotateTree(page);

    walk(page, (n) => {
      expect(n.structuralSignature).toBe(expected.get(n.id));
    });
  });

  it("fills in childCount and gives the root repeatedSiblings 1", () => {
    const tree = node({
      children: [textNode("a"), textNode("b"), textNode("c")],
    });
    tree.childCount = 999;

    annotateTree(tree);

    expect(tree.childCount).toBe(3);
    expect(tree.repeatedSiblings).toBe(1);
    expect(tree.children.map((c) => c.repeatedSiblings)).toEqual([3, 3, 3]);
  });

  it("does not blow the stack on very deep trees", () => {
    const deep = deepChain(20_000);
    expect(() => annotateTree(deep)).not.toThrow();
    expect(deep.structuralSignature).toMatch(/^s2:[0-9a-f]{16}$/);
  });

  it("returns the same root it was given", () => {
    const tree = node({});
    expect(annotateTree(tree)).toBe(tree);
  });
});

describe("module hygiene", () => {
  it("signature.ts has no imports at all, Figma or otherwise", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/ir/signature.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });
});

function walk(
  root: { id: string; children: Array<{ id: string; children: unknown[] }> },
  visit: (node: any) => void,
): void {
  const stack: any[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    visit(current);
    for (const child of current.children) stack.push(child);
  }
}
