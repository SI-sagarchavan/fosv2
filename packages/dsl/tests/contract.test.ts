/**
 * B rules — a tree's bindings against the data it will meet.
 *
 * The news grid compiled from Figma, bound two ways: by the hand-shaped plan it
 * shipped with (`headline`, `summary`, `date`, `thumbnail`) and by the CAST plan
 * written for the real CMS Listing payload (`title`, `desc`, `published_date`,
 * `thumbnail_image`). Both trees pass every S and T rule. Only one of them can
 * draw the payload, and before these rules nothing said which.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyBindingPlan, type BindingPlan } from "../src/bind.js";
import { fromCastFlow } from "../src/cast.js";
import { setProp } from "../src/ops.js";
import type { FlatTree } from "../src/flat.js";
import { validate, type Issue } from "../src/validate.js";
import { registry } from "./helpers.js";

const load = <T,>(path: string): T =>
  JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8")) as T;

const grid = () => load<FlatTree>("news-grid.json");
const castPlan = () => load<BindingPlan>("bindings/news-grid.cast.plan.json");
const response = () => load<unknown>("cast/dc-news.flow.json");
const data = () => ({ news: fromCastFlow(response()) });

const bound = () => {
  const r = applyBindingPlan(grid(), castPlan());
  expect(r.drift).toEqual([]);
  return r.tree;
};
const check = (tree: FlatTree, sample: unknown = data()) => validate(tree, { registry: registry(), data: sample });
const codes = (issues: Issue[]) => issues.map((i) => i.code);
const idOf = (tree: FlatTree, src: string) => tree.nodes.find((n) => n.src === src)!.id;

describe("the CAST plan against the CAST payload", () => {
  it("binds every card, folds the briefs, and sets each crop", () => {
    const r = applyBindingPlan(grid(), castPlan());
    expect(r).toMatchObject({ bound: 16, collapsed: 1, drift: [] });
    const ratios = r.tree.nodes.filter((n) => n.type === "Image").map((n) => n.props.ratio);
    expect(ratios).toEqual(["16/9", "1/1", "1/1", "1/1"]);
  });

  it("validates clean — no B errors, no B warnings", () => {
    const result = check(bound());
    expect(result.errors).toEqual([]);
    expect(result.warnings.filter((w) => w.code.startsWith("B"))).toEqual([]);
  });

  it("keeps the pipes through the collapse", () => {
    const repeated = bound().nodes.find((n) => n.src === "333:9720")!;
    expect(repeated.props.content).toBe('{article.published_date | date:"MMM DD, YYYY"}');
  });
});

describe("B1 — a path the payload does not have", () => {
  /**
   * Yesterday's plan binds a view model nobody serves. Every S and T rule
   * passes; the page would print `{article.headline}`.
   */
  it("fails the hand-shaped plan, and offers the fields that DO exist", () => {
    const tree = applyBindingPlan(grid(), load<BindingPlan>("bindings/news-grid.plan.json")).tree;
    expect(validate(tree, { registry: registry() }).errors).toEqual([]);

    const b1 = check(tree).errors.filter((e) => e.code === "B1");
    expect(b1.length).toBeGreaterThan(0);
    const headline = b1.find((e) => e.message.startsWith("{article.headline}"))!;
    expect(headline.message).toContain('"article" has no "headline"');
    expect(headline.message).toMatch(/it has .*\btitle\b/);
    expect(b1.some((e) => e.message.startsWith("{news.eyebrow}"))).toBe(true);
  });

  it("does not fire on a ref that brings its own `default`", () => {
    const id = idOf(bound(), "333:9687");
    const tree = setProp(bound(), id, "content", '{news.items.1.subtitle | default:""}');
    expect(codes(check(tree).errors)).not.toContain("B1");
  });
});

describe("B2 — the right path, the wrong shape", () => {
  it("rejects an object drawn as text", () => {
    const tree = setProp(bound(), idOf(bound(), "333:9687"), "content", "{news.items.1.entities.primary}");
    const b2 = check(tree).errors.find((e) => e.code === "B2")!;
    expect(b2.message).toContain("is an object");
    expect(b2.message).toMatch(/it has name, canonical, is_linkable|it has canonical, is_linkable, name/);
  });

  it("rejects a Repeater over the envelope instead of its list", () => {
    const repeater = bound().nodes.find((n) => n.type === "Repeater")!;
    const tree = setProp(bound(), repeater.id, "over", "news");
    const b2 = check(tree).errors.find((e) => e.code === "B2")!;
    expect(b2.message).toContain('did you mean "news.items"?');
  });
});

describe("B3 — binding the raw response", () => {
  /** `data.1` is page one. On page two the same template's items are under "2". */
  it("warns on a path through a page key", () => {
    const repeater = bound().nodes.find((n) => n.type === "Repeater")!;
    const tree = setProp(bound(), repeater.id, "over", "raw.data.1");
    const b3 = check(tree, { ...data(), raw: response() }).warnings.filter((w) => w.code === "B3");
    expect(b3).toHaveLength(1);
    expect(b3[0]!.message).toContain("PAGE number");
  });
});

describe("B4 — pipes", () => {
  it("rejects an unknown pipe even without data", () => {
    const tree = setProp(bound(), idOf(bound(), "333:9687"), "content", "{news.items.1.title | upper}");
    const b4 = validate(tree, { registry: registry() }).errors.filter((e) => e.code === "B4");
    expect(b4).toHaveLength(1);
    expect(b4[0]!.message).toContain('unknown pipe "upper"');
  });

  it("rejects a wrong arity and warns on date over a non-date", () => {
    const id = idOf(bound(), "333:9687");
    expect(codes(check(setProp(bound(), id, "content", "{news.items.1.published_date | date}")).errors)).toContain("B4");
    expect(
      codes(check(setProp(bound(), id, "content", '{news.items.1.title | date:"DD"}')).warnings),
    ).toContain("B4");
  });
});

describe("B5 — a raw timestamp", () => {
  it("warns when an ISO date is drawn without `date`", () => {
    const tree = setProp(bound(), idOf(bound(), "333:9691"), "content", "{news.items.1.published_date}");
    const b5 = check(tree).warnings.find((w) => w.code === "B5")!;
    expect(b5.message).toContain('date:"MMM DD, YYYY"');
  });
});

describe("B6 — the CDN crop", () => {
  it("warns when a {{RATIO}} image has no ratio — the CDN would serve 16:9 into a square", () => {
    const tree = setProp(bound(), idOf(bound(), "333:9683"), "ratio", undefined);
    const b6 = check(tree).warnings.filter((w) => w.code === "B6");
    expect(b6).toHaveLength(1);
  });

  it("rejects a ratio the CDN answers with a 1×1 pixel", () => {
    const tree = setProp(bound(), idOf(bound(), "333:9683"), "ratio", "7/5");
    const b6 = check(tree).errors.find((e) => e.code === "B6")!;
    expect(b6.message).toContain("1×1 pixel");
  });
});

describe("B7 — `when`", () => {
  const repeated = (tree: FlatTree) => tree.nodes.find((n) => n.src === "333:9720")!.id;

  it("resolves `when` paths inside the Repeater's scope", () => {
    const tree = setProp(bound(), repeated(bound()), "when", { path: "article.duration", exists: true });
    const result = check(tree);
    expect(result.errors).toEqual([]);
    expect(codes(result.warnings)).not.toContain("B7");
  });

  it("names a `when` path the item lacks", () => {
    const tree = setProp(bound(), repeated(bound()), "when", { path: "article.kind", eq: "video" });
    expect(check(tree).errors.find((e) => e.code === "B1")!.message).toContain('"article" has no "kind"');
  });

  it("warns when the comparison can never be true", () => {
    const tree = setProp(bound(), repeated(bound()), "when", { path: "article.asset_type_id", eq: "4" });
    const b7 = check(tree).warnings.find((w) => w.code === "B7")!;
    expect(b7.message).toContain("only holds number");
  });

  it("rejects a malformed `when` as a schema failure", () => {
    const tree = setProp(bound(), repeated(bound()), "when", { path: "article.duration" });
    expect(codes(validate(tree, { registry: registry() }).errors)).toContain("S12");
  });
});
