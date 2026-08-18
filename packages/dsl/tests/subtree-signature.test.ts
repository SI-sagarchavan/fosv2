/**
 * Subtree signatures.
 *
 * The interesting assertions are the two that hold the line in opposite
 * directions: copy must NOT change a signature, and `truncate` MUST. Everything
 * else follows from those two — a hash that leaks content proposes collapses
 * that lose copy, and one that ignores design decisions proposes collapses that
 * lose layout.
 *
 * The `news-grid.raw.json` fixture is the same section compiled with the crop
 * cleanup turned off. It is here to keep the reason for that cleanup on the
 * record, in numbers, rather than in a commit message nobody re-reads.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha1Hex } from "../src/sha1.js";
import {
  normaliseProps,
  stableJson,
  subtreeSignature,
  subtreeSignatures,
  SUBTREE_SIGNATURE_PREFIX,
} from "../src/subtree-signature.js";
import type { FlatNode, FlatTree } from "../src/flat.js";
import { tinyTree } from "./helpers.js";

const load = (file: string): FlatTree =>
  JSON.parse(readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8")) as FlatTree;

const grid = () => load("news-grid.json");
const rawGrid = () => load("news-grid.raw.json");

/** Sibling groups of two or more, keyed by parent. The runs a collapse can see. */
function runs(tree: FlatTree): { parentId: string; members: string[] }[] {
  const sigs = subtreeSignatures(tree);
  const byParent = new Map<string, FlatNode[]>();
  for (const node of tree.nodes) {
    if (node.parent === null) continue;
    byParent.set(node.parent, [...(byParent.get(node.parent) ?? []), node]);
  }
  const out: { parentId: string; members: string[] }[] = [];
  for (const [parentId, children] of byParent) {
    const groups = new Map<string, string[]>();
    for (const child of children.sort((a, b) => a.idx - b.idx)) {
      const sig = sigs.get(child.id)!;
      groups.set(sig, [...(groups.get(sig) ?? []), child.id]);
    }
    for (const members of groups.values()) if (members.length >= 2) out.push({ parentId, members });
  }
  return out.sort((a, b) => (a.parentId < b.parentId ? -1 : 1));
}

describe("sha1", () => {
  /**
   * Written out by hand because the pure half of this package imports nothing
   * from `node:`. That is only safe if it is the same function — including at
   * the block boundaries, where a hand-rolled implementation goes wrong.
   */
  it("agrees with node:crypto, including at 55/56/64 bytes", () => {
    for (const input of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000), "héllo — ünïcode ✓"]) {
      expect(sha1Hex(input)).toBe(createHash("sha1").update(input, "utf8").digest("hex"));
    }
  });
});

describe("shape", () => {
  it("is a versioned prefix and ten hex characters", () => {
    const sig = subtreeSignature(grid(), "stack_12");
    expect(sig).toMatch(/^d1:[0-9a-f]{10}$/);
    expect(sig.startsWith(`${SUBTREE_SIGNATURE_PREFIX}:`)).toBe(true);
  });

  it("signs every node, and the single-node form agrees with the bulk one", () => {
    const tree = grid();
    const all = subtreeSignatures(tree);
    expect(all.size).toBe(tree.nodes.length);
    expect(subtreeSignature(tree, "stack_15")).toBe(all.get("stack_15"));
  });

  it("throws for a node that is not there", () => {
    expect(() => subtreeSignature(grid(), "nope")).toThrow(/no node with id/);
  });

  it("does not depend on prop insertion order", () => {
    const a = tinyTree([{ id: "n", parent: null, idx: 0, type: "Stack", src: "1:1", props: { gap: "space.4", direction: "row" } }]);
    const b = tinyTree([{ id: "n", parent: null, idx: 0, type: "Stack", src: "1:1", props: { direction: "row", gap: "space.4" } }]);
    expect(subtreeSignature(a, "n")).toBe(subtreeSignature(b, "n"));
  });

  it("does depend on child order", () => {
    const swap = (tree: FlatTree) => ({
      ...tree,
      nodes: tree.nodes.map((n) => (n.parent === "root" ? { ...n, idx: 1 - n.idx } : n)),
    });
    const tree = tinyTree([
      { id: "root", parent: null, idx: 0, type: "Stack", src: "1:1", props: {} },
      { id: "a", parent: "root", idx: 0, type: "Text", src: "1:2", props: { content: "a", style: "type.body_md_bold" } },
      { id: "b", parent: "root", idx: 1, type: "Divider", src: "1:3", props: { orientation: "horizontal" } },
    ]);
    expect(subtreeSignature(tree, "root")).not.toBe(subtreeSignature(swap(tree), "root"));
  });
});

describe("what is excluded — content and identity", () => {
  const tree = () => grid();

  it("changing a Text's content changes nothing", () => {
    const before = subtreeSignatures(tree());
    const edited = tree();
    for (const node of edited.nodes) {
      if (node.type === "Text") node.props = { ...node.props, content: "COMPLETELY DIFFERENT COPY" };
    }
    expect([...subtreeSignatures(edited)]).toEqual([...before]);
  });

  it("changing src, alt, href, label, testId, icon name or _meta changes nothing", () => {
    const before = subtreeSignatures(tree());
    const edited = tree();
    for (const node of edited.nodes) {
      const props: Record<string, unknown> = { ...node.props };
      if (props.src !== undefined) props.src = "https://cdn.example/x.jpg";
      if (props.alt !== undefined) props.alt = "different alt";
      if (props.label !== undefined) props.label = "DIFFERENT";
      if (node.type === "Icon") props.name = "different_glyph";
      props.testId = `test-${node.id}`;
      props._meta = { note: "touched" };
      node.props = props;
    }
    expect([...subtreeSignatures(edited)]).toEqual([...before]);
  });

  /**
   * A navigate action's href is the article, not the card. Three briefs
   * pointing at three stories are three instances of one component, and the URL
   * nests one level down where a top-level exclusion would miss it.
   */
  it("ignores a content prop nested inside another prop", () => {
    const withHref = (href: string) =>
      tinyTree([
        {
          id: "b",
          parent: null,
          idx: 0,
          type: "Button",
          src: "1:1",
          props: { label: "READ", variant: "outline", styleN: 2, size: "sm", action: { kind: "navigate", href } },
        },
      ]);
    expect(subtreeSignature(withHref("/news/1"), "b")).toBe(subtreeSignature(withHref("/news/2"), "b"));
  });

  it("keeps Custom.ref while ignoring Custom.props", () => {
    const custom = (ref: string, props: Record<string, unknown>) =>
      tinyTree([{ id: "c", parent: null, idx: 0, type: "Custom", src: "1:1", props: { ref, props } }]);
    expect(subtreeSignature(custom("scoreboard@1.0.0", { a: 1 }), "c")).toBe(
      subtreeSignature(custom("scoreboard@1.0.0", { a: 2 }), "c"),
    );
    expect(subtreeSignature(custom("scoreboard@1.0.0", { a: 1 }), "c")).not.toBe(
      subtreeSignature(custom("scoreboard@2.0.0", { a: 1 }), "c"),
    );
  });
});

describe("what is kept — design decisions", () => {
  /**
   * The load-bearing one. On this page the middle cards clamp 3 lines of
   * headline and 3 of summary; the trailing cards clamp 2 and 1. Those are two
   * variants of a card. A signature that folded them together would propose one
   * Repeater over all five and silently drop a line of copy from three of them.
   */
  it("changing a truncate changes the signature", () => {
    const before = subtreeSignature(grid(), "stack_12");
    const edited = grid();
    const text = edited.nodes.find((n) => n.id === "james_vince_stroked_60_from_38_and_chris_3")!;
    text.props = { ...text.props, truncate: 2 };
    expect(subtreeSignature(edited, "stack_12")).not.toBe(before);
  });

  it("keeps the middle cards and the trailing cards apart", () => {
    const sigs = subtreeSignatures(grid());
    expect(sigs.get("stack_6")).not.toBe(sigs.get("stack_12"));
  });

  it("keeps tokens, anchors, clip and layout", () => {
    const base: FlatNode = { id: "n", parent: null, idx: 0, type: "Stack", src: "1:1", props: { gap: "space.4", direction: "row", clip: true } };
    const sig = (props: Record<string, unknown>) => subtreeSignature(tinyTree([{ ...base, props }]), "n");
    const original = sig(base.props);
    expect(sig({ ...base.props, gap: "space.6" })).not.toBe(original);
    expect(sig({ ...base.props, direction: "column" })).not.toBe(original);
    expect(sig({ ...base.props, clip: false })).not.toBe(original);
    expect(sig({ ...base.props, surface: "surface.card_stat" })).not.toBe(original);
  });
});

describe("raw bucketing", () => {
  const sized = (w: number) =>
    subtreeSignature(
      tinyTree([{ id: "n", parent: null, idx: 0, type: "Box", src: "1:1", props: { size: { w: { raw: w, _unbound: true } } } }]),
      "n",
    );

  it("absorbs instance drift", () => {
    expect(sized(116)).toBe(sized(116.0001));
    expect(sized(116)).toBe(sized(117));
  });

  it("does not absorb a real difference", () => {
    expect(sized(116)).not.toBe(sized(182));
  });

  it("serialises a bucketed raw distinguishably", () => {
    expect(stableJson(normaliseProps("Box", { size: { w: { raw: 241.8481, _unbound: true } } }))).toBe(
      '{"size":{"w":"raw~240"}}',
    );
  });
});

describe("the news grid, with and without the crop cleanup", () => {
  /**
   * Figma crops by absolutely positioning an oversized bitmap, so every image
   * carries four raw values that measure the BITMAP. Two instances of one card
   * disagree about all four, which splits a pair that should merge.
   */
  it("without the cleanup, the two middle cards differ in two nodes", () => {
    expect(differingNodes(rawGrid(), "stack_6", "stack_9")).toEqual(["stack_6/stack_9", "image_2/image_3"]);
  });

  it("with the cleanup, the image stops being one of them", () => {
    expect(differingNodes(grid(), "stack_6", "stack_9")).toEqual(["stack_6/stack_9"]);
  });

  /**
   * WHAT IS LEFT, and why the middle pair still does not merge.
   *
   * The designer set the gap between thumbnail and content to 0 on the first
   * middle card and 8 on the second. That is a real, visible 8px, and it is in
   * the IR — it has nothing to do with the crop cleanup and survives it. The
   * signature is right to keep them apart; folding them would move one card's
   * content 8px and call it a tidy-up. The fix belongs in the Figma file.
   */
  it("what still separates the middle pair is an 8px gap the designer left", () => {
    const tree = grid();
    const a = tree.nodes.find((n) => n.id === "stack_6")!;
    const b = tree.nodes.find((n) => n.id === "stack_9")!;
    expect(a.props.gap).toBeUndefined();
    expect(b.props.gap).toBe("space.2");

    // Give them the same gap and nothing else, and they merge.
    a.props = { ...a.props, gap: "space.2" };
    const sigs = subtreeSignatures(tree);
    expect(sigs.get("stack_6")).toBe(sigs.get("stack_9"));
  });

  it("finds one run before the cleanup and one after — trailing_column both times", () => {
    for (const tree of [rawGrid(), grid()]) {
      const found = runs(tree);
      expect(found).toHaveLength(1);
      expect(found[0]!.parentId).toBe("trailing_column");
      expect(found[0]!.members).toEqual(["stack_12", "stack_15", "stack_18"]);
    }
  });

  /**
   * Distinct-signature counts, as measured. The cleanup takes three shapes out
   * of circulation: the three images whose crop boxes were unique to them.
   */
  it("collapses three distinct shapes out of the tree", () => {
    expect(distinct(rawGrid())).toBe(37);
    expect(distinct(grid())).toBe(34);
  });
});

// ---------------------------------------------------------------------------

function distinct(tree: FlatTree): number {
  return new Set(subtreeSignatures(tree).values()).size;
}

/** Which template-relative positions differ, comparing two subtrees in lockstep. */
function differingNodes(tree: FlatTree, a: string, b: string): string[] {
  const walk = (id: string): FlatNode[] => {
    const node = tree.nodes.find((n) => n.id === id)!;
    const kids = tree.nodes.filter((n) => n.parent === id).sort((x, y) => x.idx - y.idx);
    return [node, ...kids.flatMap((k) => walk(k.id))];
  };
  const left = walk(a);
  const right = walk(b);
  const out: string[] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    const sx = x ? `${x.type} ${stableJson(normaliseProps(x.type, x.props))}` : "";
    const sy = y ? `${y.type} ${stableJson(normaliseProps(y.type, y.props))}` : "";
    if (sx !== sy) out.push(`${x?.id ?? "—"}/${y?.id ?? "—"}`);
  }
  return out;
}
