/**
 * Collapse proposals, applying one, and `Repeater.slice`.
 *
 * The rule the whole file is built around: a proposal changes nothing. Every
 * assertion about `proposeCollapse` is about what it REPORTS, and the one
 * function that edits a tree takes a binding as an argument because the tree
 * cannot supply it.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { proposeCollapse } from "../src/collapse.js";
import { applyCollapse, TreeOpError } from "../src/ops.js";
import { subtreeSignatures } from "../src/subtree-signature.js";
import { flatten, reify, type FlatNode, type FlatTree } from "../src/flat.js";
import { validate, issuesByCode } from "../src/validate.js";
import { registry, tinyTree } from "./helpers.js";

const grid = (): FlatTree =>
  JSON.parse(readFileSync(new URL("../fixtures/news-grid.json", import.meta.url), "utf8")) as FlatTree;

const binding = (): Parameters<typeof applyCollapse>[2] =>
  JSON.parse(
    readFileSync(new URL("../fixtures/bindings/news-grid.binding.json", import.meta.url), "utf8"),
  ) as Parameters<typeof applyCollapse>[2];

// ---------------------------------------------------------------------------
// Part 3 — proposals
// ---------------------------------------------------------------------------

describe("proposeCollapse on the news grid", () => {
  const proposals = () => proposeCollapse(grid());

  /**
   * ONE, not two.
   *
   * The middle column's two cards are the same component and do NOT group,
   * because the designer set the thumbnail gap to 0 on one and 8 on the other.
   * See the signature suite, which proves the gap is the only thing left. A
   * proposal here would be a proposal to move content 8px.
   */
  it("finds the trailing run and nothing else", () => {
    const found = proposals();
    expect(found.map((p) => p.parentId)).toEqual(["trailing_column"]);
  });

  it("describes the run exactly", () => {
    const [trailing] = proposals();
    expect(trailing).toMatchObject({
      parentId: "trailing_column",
      memberIds: ["stack_12", "stack_15", "stack_18"],
      templateId: "stack_12",
      count: 3,
      nodesPerMember: 10,
      nodesSaved: 20,
      contiguous: true,
    });
  });

  /**
   * EMPTY, and that is the finding.
   *
   * All three trailing cards carry the same pasted placeholder copy, so the
   * item's fields cannot be read off the design by looking for what differs.
   * A binder told this can go and ask a contract instead of inventing field
   * names from three identical strings.
   */
  it("reports no varying content, because the design has none", () => {
    expect(proposals()[0]!.varyingContent).toEqual({});
  });

  it("does not touch the tree", () => {
    const before = JSON.stringify(grid());
    proposeCollapse(grid());
    expect(JSON.stringify(grid())).toBe(before);
  });

  it("returns the same order every time", () => {
    expect(JSON.stringify(proposeCollapse(grid()))).toBe(JSON.stringify(proposeCollapse(grid())));
  });
});

describe("what proposeCollapse refuses", () => {
  /** Two matching siblings with something else between them: coincidence, not a list. */
  it("says nothing about a scattered pair", () => {
    const tree = tinyTree([
      row("root"),
      ...card("a", "root", 0),
      { id: "spacer", parent: "root", idx: 1, type: "Divider", src: "1:9", props: { orientation: "horizontal" } },
      ...card("b", "root", 2),
    ]);
    const sigs = subtreeSignatures(tree);
    expect(sigs.get("a")).toBe(sigs.get("b"));
    expect(proposeCollapse(tree)).toEqual([]);
  });

  it("proposes an adjacent pair, which is a run", () => {
    const tree = tinyTree([
      row("root"),
      ...card("a", "root", 0),
      ...card("b", "root", 1),
      { id: "footer", parent: "root", idx: 2, type: "Divider", src: "1:19", props: { orientation: "horizontal" } },
    ]);
    const [only] = proposeCollapse(tree);
    expect(only).toMatchObject({ count: 2, contiguous: true });
  });

  it("says nothing about the root's entire child set — that is the page", () => {
    const tree = tinyTree([row("root"), ...card("a", "root", 0), ...card("b", "root", 1), ...card("c", "root", 2)]);
    expect(proposeCollapse(tree)).toEqual([]);
  });

  it("proposes a run under the root that is not ALL of the root's children", () => {
    const tree = tinyTree([
      row("root"),
      ...card("a", "root", 0),
      ...card("b", "root", 1),
      { id: "footer", parent: "root", idx: 2, type: "Divider", src: "1:20", props: { orientation: "horizontal" } },
    ]);
    expect(proposeCollapse(tree).map((p) => p.count)).toEqual([2]);
  });

  it("says nothing about members that already repeat", () => {
    const tree = tinyTree([
      row("root"),
      ...withRepeater("a", "root", 0),
      ...withRepeater("b", "root", 1),
      { id: "footer", parent: "root", idx: 2, type: "Divider", src: "1:30", props: { orientation: "horizontal" } },
    ]);
    expect(proposeCollapse(tree)).toEqual([]);
  });
});

describe("varyingContent", () => {
  const varied = (...headlines: string[]) =>
    tinyTree([
      row("root"),
      ...headlines.flatMap((h, i) => card(`c${i}`, "root", i, h)),
      { id: "footer", parent: "root", idx: headlines.length, type: "Divider", src: "1:40", props: { orientation: "horizontal" } },
    ]);

  it("names the node and prop that differ, with the distinct values", () => {
    const [proposal] = proposeCollapse(varied("One", "Two", "Three"));
    expect(proposal!.varyingContent).toEqual({
      c0_text: [{ prop: "content", values: ["One", "Two", "Three"] }],
    });
  });

  it("keys by the TEMPLATE's node id, so a binder can name what it binds", () => {
    const [proposal] = proposeCollapse(varied("One", "Two", "Three"));
    expect(Object.keys(proposal!.varyingContent)[0]).toBe(`${proposal!.templateId}_text`);
  });

  it("reports the distinct values, not one per member", () => {
    // Two of the three share a headline: two values across three members.
    const [proposal] = proposeCollapse(varied("One", "One", "Three"));
    expect(proposal!.varyingContent.c0_text).toEqual([{ prop: "content", values: ["One", "Three"] }]);
  });

  /** One node, two varying props. The old `nodeId.prop` key could not say this. */
  it("lists every varying prop on a node, not just the first", () => {
    const withImages = (alts: string[]) =>
      tinyTree([
        row("root"),
        ...alts.flatMap((alt, i) => [
          { id: `c${i}`, parent: "root", idx: i, type: "Stack", src: `10:${i}`, props: { gap: "space.2" } } as FlatNode,
          {
            id: `c${i}_img`,
            parent: `c${i}`,
            idx: 0,
            type: "Image",
            src: `11:${i}`,
            props: { src: `/img/${i}.jpg`, alt, fit: "cover" },
          } as FlatNode,
        ]),
        { id: "footer", parent: "root", idx: alts.length, type: "Divider", src: "1:50", props: { orientation: "horizontal" } } as FlatNode,
      ]);
    const [proposal] = proposeCollapse(withImages(["one", "two", "three"]));
    expect(proposal!.varyingContent.c0_img!.map((v) => v.prop).sort()).toEqual(["alt", "src"]);
  });

  /**
   * Anything that varies is by construction something the signature excluded —
   * the members would not have grouped otherwise. Worth asserting, because a
   * leak in either direction would show up here first.
   */
  it("only ever names props the signature ignores", () => {
    const tree = varied("One", "Two", "Three");
    const [proposal] = proposeCollapse(tree);
    for (const entries of Object.values(proposal!.varyingContent)) {
      for (const entry of entries) {
        expect(["content", "alt", "href", "label", "testId", "src", "name", "options", "to"]).toContain(entry.prop);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Part 4 — applying
// ---------------------------------------------------------------------------

describe("applyCollapse", () => {
  const applied = () => {
    const tree = grid();
    return applyCollapse(tree, proposeCollapse(tree)[0]!, binding());
  };

  it("takes the grid from 69 nodes to 50 — twenty removed, one Repeater added", () => {
    expect(grid().nodes).toHaveLength(69);
    expect(applied().nodes).toHaveLength(50);
  });

  it("reifies and validates clean", () => {
    const out = applied();
    expect(() => reify(out)).not.toThrow();
    const result = validate(out, { registry: registry() });
    expect(result.errors.map((e) => `${e.code} ${e.nodeId ?? ""}`)).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("round-trips through reify and flatten", () => {
    const out = applied();
    expect(flatten(reify(out), out.schemaVersion).nodes.map((n) => n.id)).toEqual(out.nodes.map((n) => n.id));
  });

  it("keeps every surviving node's original src", () => {
    const before = new Map(grid().nodes.map((n) => [n.id, n.src]));
    for (const node of applied().nodes) {
      if (node.type === "Repeater") continue;
      expect(node.src).toBe(before.get(node.id));
    }
  });

  /**
   * `src` is the anchor a pixel diff maps a region onto and the key drift
   * detection joins on. Collapsing three cards deletes two thirds of them, so
   * the Repeater carries the list — every node under the removed members, not
   * just their roots, because coverage is counted per painting node.
   */
  it("records every removed node's src on the Repeater", () => {
    const repeater = applied().nodes.find((n) => n.type === "Repeater")!;
    const collapsedFrom = (repeater.props._meta as { collapsedFrom: string[] }).collapsedFrom;
    const removed = grid()
      .nodes.filter((n) => descendsFrom(grid(), n.id, "stack_15") || descendsFrom(grid(), n.id, "stack_18"))
      .map((n) => n.src);
    expect(collapsedFrom).toEqual(removed);
    expect(collapsedFrom).toHaveLength(20);
  });

  it("rewrites the mapped props into interpolation form", () => {
    const byId = new Map(applied().nodes.map((n) => [n.id, n]));
    expect(byId.get("james_vince_fires_southern_brave_to_firs_2")!.props.content).toBe("{article.headline}");
    expect(byId.get("james_vince_stroked_60_from_38_and_chris_3")!.props.content).toBe("{article.summary}");
    expect(byId.get("mar_22_2025_3")!.props.content).toBe("{article.date}");
    expect(byId.get("image_4")!.props.src).toBe("{article.thumbnail}");
  });

  it("leaves unmapped props alone", () => {
    const text = applied().nodes.find((n) => n.id === "james_vince_fires_southern_brave_to_firs_2")!;
    expect(text.props.style).toBe("type.body_md_bold");
    expect(text.props.truncate).toBe(2);
  });

  it("puts the Repeater in the template's slot, carrying the binding", () => {
    const repeater = applied().nodes.find((n) => n.type === "Repeater")!;
    expect(repeater.parent).toBe("trailing_column");
    expect(repeater.idx).toBe(0);
    expect(repeater.props.over).toBe("news.items");
    expect(repeater.props.as).toBe("article");
    expect(repeater.props.slice).toEqual([3, 6]);
    expect(applied().nodes.find((n) => n.id === "stack_12")!.parent).toBe(repeater.id);
  });

  it("does not mutate the tree it was given", () => {
    const tree = grid();
    const before = JSON.stringify(tree);
    applyCollapse(tree, proposeCollapse(tree)[0]!, binding());
    expect(JSON.stringify(tree)).toBe(before);
  });

  it("refuses a fieldMap that names a node outside the template", () => {
    const tree = grid();
    expect(() =>
      applyCollapse(tree, proposeCollapse(tree)[0]!, {
        ...binding(),
        fieldMap: { south_coast_stories: { prop: "content", path: "headline" } },
      }),
    ).toThrow(TreeOpError);
  });

  it("refuses an alias that cannot head a data path", () => {
    const tree = grid();
    expect(() => applyCollapse(tree, proposeCollapse(tree)[0]!, { ...binding(), as: "the article" })).toThrow(
      /bare name/,
    );
  });

  it("refuses a backwards slice", () => {
    const tree = grid();
    expect(() => applyCollapse(tree, proposeCollapse(tree)[0]!, { ...binding(), slice: [6, 3] })).toThrow(
      /slice must be/,
    );
  });

  it("refuses a template that is not one of the members", () => {
    const tree = grid();
    const proposal = proposeCollapse(tree)[0]!;
    expect(() => applyCollapse(tree, { ...proposal, templateId: "stack" }, binding())).toThrow(
      /not one of the members/,
    );
  });

  it("works with no slice and no fieldMap — the minimum honest collapse", () => {
    const tree = grid();
    const out = applyCollapse(tree, proposeCollapse(tree)[0]!, { over: "news.items", as: "article", fieldMap: {} });
    const repeater = out.nodes.find((n) => n.type === "Repeater")!;
    expect(repeater.props.slice).toBeUndefined();
    expect(validate(out, { registry: registry() }).errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Part 5 — Repeater.slice
// ---------------------------------------------------------------------------

describe("Repeater.slice", () => {
  const repeater = (props: Record<string, unknown>): FlatTree =>
    tinyTree([
      { id: "root", parent: null, idx: 0, type: "Stack", src: "1:1", props: {} },
      { id: "r", parent: "root", idx: 0, type: "Repeater", src: "1:2", props: { over: "news.items", as: "article", ...props } },
      { id: "card", parent: "r", idx: 0, type: "Box", src: "1:3", props: {} },
    ]);

  const codes = (tree: FlatTree) => {
    const result = validate(tree, { registry: registry() });
    return [...result.errors, ...result.warnings].map((i) => i.code);
  };

  it("accepts a well-formed window", () => {
    expect(codes(repeater({ slice: [1, 3] }))).toEqual([]);
  });

  it("rejects slice and limit together", () => {
    const issues = issuesByCode(validate(repeater({ slice: [0, 3], limit: 2 }), { registry: registry() }), "S13");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/two answers/);
  });

  it("rejects an end that is not past the start", () => {
    expect(codes(repeater({ slice: [3, 3] }))).toEqual(["S13"]);
    expect(codes(repeater({ slice: [4, 2] }))).toEqual(["S13"]);
  });

  it("rejects a negative start", () => {
    expect(codes(repeater({ slice: [-1, 3] }))).toContain("S13");
  });

  it("rejects a slice that is not a pair of integers", () => {
    expect(codes(repeater({ slice: [1] }))).toContain("S13");
    expect(codes(repeater({ slice: [1, 2, 3] }))).toContain("S13");
    expect(codes(repeater({ slice: [0.5, 3] }))).toContain("S13");
  });

  /**
   * The index-tiered grid this exists for: one list of six articles drawn as
   * a lead, two features and three briefs. Adjacent windows, no overlap.
   */
  it("is quiet about adjacent windows over one source", () => {
    expect(codes(tiers([0, 1], [1, 3], [3, 6]))).toEqual([]);
  });

  it("warns when two windows over one source overlap", () => {
    const result = validate(tiers([0, 1], [0, 3], [3, 6]), { registry: registry() });
    expect(result.errors).toEqual([]);
    const warnings = issuesByCode(result, "S14");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/items 0\.\.0 are drawn twice/);
  });

  it("does not warn across different sources", () => {
    const tree = tiers([0, 3], [0, 3], [3, 6]);
    tree.nodes.find((n) => n.id === "r1")!.props.over = "features.items";
    expect(issuesByCode(validate(tree, { registry: registry() }), "S14")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

/** Three columns, each holding a Repeater over one source. */
function tiers(...windows: [number, number][]): FlatTree {
  const nodes: FlatNode[] = [{ id: "root", parent: null, idx: 0, type: "Stack", src: "1:1", props: {} }];
  windows.forEach((slice, i) => {
    nodes.push({ id: `col${i}`, parent: "root", idx: i, type: "Stack", src: `2:${i}`, props: {} });
    nodes.push({ id: `r${i}`, parent: `col${i}`, idx: 0, type: "Repeater", src: `3:${i}`, props: { over: "news.items", as: "article", slice } });
    nodes.push({ id: `card${i}`, parent: `r${i}`, idx: 0, type: "Box", src: `4:${i}`, props: {} });
  });
  return tinyTree(nodes);
}

function row(id: string): FlatNode {
  return { id, parent: null, idx: 0, type: "Stack", src: "1:0", props: { direction: "row" } };
}

/** A two-node card: a Stack with one Text in it. */
function card(id: string, parent: string, idx: number, content = "same"): FlatNode[] {
  return [
    { id, parent, idx, type: "Stack", src: `10:${id}`, props: { gap: "space.2" } },
    { id: `${id}_text`, parent: id, idx: 0, type: "Text", src: `11:${id}`, props: { content, style: "type.body_md_bold" } },
  ];
}

function withRepeater(id: string, parent: string, idx: number): FlatNode[] {
  return [
    { id, parent, idx, type: "Stack", src: `20:${id}`, props: { gap: "space.2" } },
    { id: `${id}_rep`, parent: id, idx: 0, type: "Repeater", src: `21:${id}`, props: { over: "x.y", as: "z" } },
    { id: `${id}_text`, parent: `${id}_rep`, idx: 0, type: "Text", src: `22:${id}`, props: { content: "c", style: "type.body_md_bold" } },
  ];
}

function descendsFrom(tree: FlatTree, id: string, ancestor: string): boolean {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  let cur: string | null = id;
  while (cur) {
    if (cur === ancestor) return true;
    cur = byId.get(cur)?.parent ?? null;
  }
  return false;
}
