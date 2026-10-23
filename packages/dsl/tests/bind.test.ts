/**
 * `applyBindingPlan` — one plan, many compiles of the same frame.
 *
 * The two things worth pinning are the two that make it safe to apply a plan
 * without knowing which export you have: it targets `src` rather than node id,
 * and anything it cannot land is reported instead of written.
 *
 * The fixtures are real. `news-grid.json` and `news-grid.raw.json` are the same
 * Southern Brave section compiled two ways, and the plan is the one shipped in
 * `fixtures/bindings/`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyBindingPlan, hasBindings, type BindingPlan } from "../src/bind.js";
import { validate } from "../src/validate.js";
import { reify, type FlatNode, type FlatTree } from "../src/flat.js";
import { registry, tinyTree } from "./helpers.js";

const load = <T,>(path: string): T =>
  JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8")) as T;

const grid = () => load<FlatTree>("news-grid.json");
const plan = () => load<BindingPlan>("bindings/news-grid.plan.json");

describe("hasBindings", () => {
  /**
   * The reason `?data=` on a fresh run looks broken: a compiled tree keeps
   * Figma's literal characters, so a data document has nothing to fill.
   */
  it("is false for a compiled tree and true once a plan has run", () => {
    expect(hasBindings(grid())).toBe(false);
    expect(hasBindings(applyBindingPlan(grid(), plan()).tree)).toBe(true);
  });
});

describe("applying the news-grid plan", () => {
  const applied = () => applyBindingPlan(grid(), plan());

  it("binds every text and folds the trailing run", () => {
    const { tree, collapsed } = applied();
    const literal = tree.nodes
      .filter((n) => n.type === "Text")
      .filter((n) => !String(n.props.content ?? "").includes("{"));
    expect(literal.map((n) => n.id)).toEqual([]);
    expect(collapsed).toBe(1);
    expect(tree.nodes.filter((n) => n.type === "Repeater")).toHaveLength(1);
  });

  it("produces a tree that reifies and validates", () => {
    const { tree } = applied();
    expect(() => reify(tree)).not.toThrow();
    expect(validate(tree, { registry: registry() }).errors).toEqual([]);
  });

  it("rewrites into interpolation form, scoped by the Repeater's alias", () => {
    const byId = new Map(applied().tree.nodes.map((n) => [n.id, n]));
    expect(byId.get("over_400_players_will_be_available_in_th")!.props.content).toBe(
      "{news.items.0.headline}",
    );
    // Inside the template the path is relative to ONE item.
    expect(byId.get("james_vince_fires_southern_brave_to_firs_2")!.props.content).toBe(
      "{article.headline}",
    );
  });

  it("does not mutate the tree it was given", () => {
    const tree = grid();
    const before = JSON.stringify(tree);
    applyBindingPlan(tree, plan());
    expect(JSON.stringify(tree)).toBe(before);
  });

  /**
   * The whole argument for keying by `src`. These two fixtures are the same
   * frame compiled with the crop cleanup on and off — different props, same
   * Figma ids — and one plan has to land on both.
   */
  it("lands on a different compile of the same frame", () => {
    const raw = applyBindingPlan(load<FlatTree>("news-grid.raw.json"), plan());
    expect(hasBindings(raw.tree)).toBe(true);
    expect(raw.collapsed).toBe(1);
  });
});

describe("drift — what a plan cannot land, it reports", () => {
  const textTree = (type: string) =>
    tinyTree([
      { id: "root", parent: null, idx: 0, type: "Stack", src: "1:1", props: {} },
      {
        id: "leaf",
        parent: "root",
        idx: 0,
        type,
        src: "1:2",
        props:
          type === "Text"
            ? { content: "hello", style: "type.body_md_bold" }
            : { direction: "column" },
      } as FlatNode,
    ]);

  it("reports a src the frame no longer has, and binds nothing for it", () => {
    const result = applyBindingPlan(textTree("Text"), {
      bind: [{ src: "9:9", prop: "content", path: "a.b" }],
    });
    expect(result.bound).toBe(0);
    expect(result.drift).toEqual([
      { reason: "missing", src: "9:9", message: expect.stringContaining("not in this tree") },
    ]);
  });

  /**
   * The real case: the news grid's button is a `Button` in one export and a
   * plain `Stack` in another, and `label` exists on only one. Written blind it
   * produces a tree that fails S12 with a prop nobody put there on purpose.
   */
  it("refuses a prop the node's type does not declare", () => {
    const result = applyBindingPlan(textTree("Stack"), {
      bind: [{ src: "1:2", prop: "label", path: "news.cta" }],
    });
    expect(result.bound).toBe(0);
    expect(result.drift[0]).toMatchObject({ reason: "wrong-type", src: "1:2" });
    expect(result.drift[0]!.message).toContain("Stack");
    // …and the tree it hands back is still clean.
    expect(validate(result.tree, { registry: registry() }).errors).toEqual([]);
  });

  it("still applies everything that CAN land", () => {
    const result = applyBindingPlan(textTree("Text"), {
      bind: [
        { src: "9:9", prop: "content", path: "gone" },
        { src: "1:2", prop: "content", path: "a.b" },
      ],
    });
    expect(result.bound).toBe(1);
    expect(result.drift).toHaveLength(1);
    expect(result.tree.nodes.find((n) => n.id === "leaf")!.props.content).toBe("{a.b}");
  });

  /**
   * A plan that names siblings the signature does NOT group would fold a card
   * that is not a repeat, losing whatever made it different. Disagreement is
   * drift, not something to push through.
   */
  it("refuses to collapse siblings that are not a detected run", () => {
    const tree = tinyTree([
      { id: "root", parent: null, idx: 0, type: "Stack", src: "1:1", props: { direction: "row" } },
      { id: "a", parent: "root", idx: 0, type: "Text", src: "2:1", props: { content: "a", style: "type.body_md_bold" } },
      { id: "b", parent: "root", idx: 1, type: "Box", src: "2:2", props: {} },
      { id: "c", parent: "root", idx: 2, type: "Box", src: "2:3", props: {} },
    ]);
    const result = applyBindingPlan(tree, {
      collapse: [{ over: "x.items", as: "item", members: ["2:1", "2:2"] }],
    });
    expect(result.collapsed).toBe(0);
    expect(result.drift[0]!.reason).toBe("not-a-run");
    expect(result.tree.nodes.filter((n) => n.type === "Repeater")).toEqual([]);
  });

  /**
   * Applying an unrelated plan is therefore SAFE rather than destructive: every
   * entry drifts and the tree comes back untouched. That is what lets a preview
   * apply a plan without first proving it belongs to the frame.
   */
  it("leaves a tree untouched when the plan belongs to a different frame", () => {
    const tree = grid();
    const result = applyBindingPlan(tree, {
      bind: [{ src: "999:1", prop: "content", path: "a" }],
      collapse: [{ over: "x", as: "y", members: ["999:2", "999:3"] }],
    });
    expect(result.bound).toBe(0);
    expect(result.collapsed).toBe(0);
    expect(result.drift).toHaveLength(2);
    expect(JSON.stringify(result.tree)).toBe(JSON.stringify(tree));
  });
});
