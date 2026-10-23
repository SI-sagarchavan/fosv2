/**
 * The inspector against the repo's own fixtures.
 *
 * What is pinned here is the JOIN — which IR node became which DSL node, what
 * was reported lost — because that is the part no other package tests. The
 * compiler, gate and validator have their own suites; these assert that this
 * layer reports what they found, faithfully and once.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { analyzeBindings } from "../server/bindings.js";
import { inspect } from "../server/inspect.js";

const repo = resolve(import.meta.dirname, "../../..");
const json = (path: string): any => JSON.parse(readFileSync(resolve(repo, path), "utf8"));

const theme = json("packages/tokens/fixtures/southern-brave.json");
const newsCard = () => json("packages/conform/fixtures/ir/news-card.ir.json");
const newsGrid = () => json("packages/compile/fixtures/news-grid.ir.json");
const newsData = () => json("packages/renderer/fixtures/news-grid.data.json");

describe("inspect", () => {
  it("accounts for every IR node exactly once", async () => {
    const r = await inspect({ ir: newsGrid(), theme, themeSource: "test" });

    expect(r.irRows).toHaveLength(r.stats.irNodes);
    expect(new Set(r.irRows.map((row) => row.id)).size).toBe(r.irRows.length);

    const dslIds = new Set(r.dsl.nodes.map((n) => n.id));
    for (const row of r.irRows) {
      // A direct row points at the one node that draws it; nothing points nowhere.
      if (row.status === "direct") expect(row.dsl).toHaveLength(1);
      for (const id of row.dsl) expect(dslIds.has(id)).toBe(true);
    }
  });

  it("agrees with the gate's own coverage count", async () => {
    const r = await inspect({ ir: newsGrid(), theme, themeSource: "test" });
    const missing = r.irRows.filter((row) => row.status === "missing").length;
    expect(missing).toBe(r.stats.coverage.missing);
  });

  it("says a text layer was DROPPED when no type token resolves, and says it once", async () => {
    const r = await inspect({ ir: newsCard(), theme, themeSource: "test" });
    const id = "I1:4924;13448:62724"; // "3 minute read"

    // The compiler returns `false` for it: the words never reach the tree.
    expect(r.dsl.nodes.some((n) => n.props.content === "3 minute read")).toBe(false);
    expect(r.irRows.find((row) => row.id === id)?.status).toBe("missing");

    const dropped = r.gaps.filter((g) => g.title.includes("DROPPED"));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ severity: "error", category: "judgment" });
    expect(dropped[0]!.irIds).toContain(id);

    // …and is NOT also reported as a separate "appears nowhere" content gap.
    expect(r.gaps.some((g) => g.category === "content" && g.irIds.includes(id))).toBe(false);
  });

  it("reports that nothing is bound, for a tree that came straight from the compiler", async () => {
    const r = await inspect({ ir: newsGrid(), theme, themeSource: "test" });
    expect(r.stats.bound).toEqual({ refs: 0, repeaters: 0 });
    expect(r.gaps.some((g) => g.category === "logic" && g.severity === "warning")).toBe(true);
  });

  it("renders when asked, and not otherwise", async () => {
    const without = await inspect({ ir: newsCard(), theme, themeSource: "test" });
    expect(without.html).toBeUndefined();

    const withHtml = await inspect({ ir: newsCard(), theme, themeSource: "test", render: true });
    expect(withHtml.html).toContain("<!DOCTYPE html>");
  });

  it("refuses a document that is not an IR, in words rather than a Zod dump", async () => {
    await expect(inspect({ ir: { nope: 1 }, theme, themeSource: "test" })).rejects.toThrow();
  });
});

describe("analyzeBindings", () => {
  it("finds the eyebrow and the CTA by exact copy, and maps the trailing cards by position", async () => {
    const r = await analyzeBindings({ ir: newsGrid(), theme, data: newsData() });

    const binds = r.suggestions.filter((s) => s.kind === "bind");
    expect(binds.map((s) => (s.entry as { path: string }).path).sort()).toEqual(["news.cta", "news.eyebrow"]);
    expect(binds.every((s) => s.basis === "exact")).toBe(true);

    const repeat = r.suggestions.find((s) => s.kind === "collapse");
    expect(repeat?.basis).toBe("ambiguous"); // the three cards carry the same pasted copy
    expect((repeat?.entry as { over: string }).over).toBe("news.items");
    expect((repeat?.entry as { fields: Array<{ path: string }> }).fields.map((f) => f.path)).toEqual([
      "headline",
      "summary",
      "date",
      "thumbnail",
    ]);
  });

  it("applying every suggestion binds cleanly and leaves nothing unread", async () => {
    const first = await analyzeBindings({ ir: newsGrid(), theme, data: newsData() });
    const plan = {
      bind: first.suggestions.filter((s) => s.kind === "bind").map((s) => s.entry),
      collapse: first.suggestions.filter((s) => s.kind === "collapse").map((s) => s.entry),
    } as never;

    const r = await analyzeBindings({ ir: newsGrid(), theme, data: newsData(), plan });

    expect(r.applied).toMatchObject({ bound: 6, collapsed: 1, drift: [] });
    expect(r.repeaters).toHaveLength(1);
    expect(r.repeaters[0]).toMatchObject({ over: "news.items", as: "item", items: 6 });
    expect(r.unresolved).toEqual([]);
    expect(r.unused).toEqual([]);
    // The alias is shown as the list path it reads, not as `item.headline`.
    expect(r.refs.map((x) => x.path)).toContain("news.items[].headline");
  });

  it("lists an API field the tree never reads", async () => {
    const data = newsData();
    data.news.items[0].badge = "LIVE";

    const r = await analyzeBindings({ ir: newsGrid(), theme, data });
    expect(r.unused).toContain("news.items[].badge");
    expect(r.shape.find((s) => s.path === "news.items[].badge")?.hint).toBe("Text");
  });

  it("reports a path the tree asks for that the sample lacks", async () => {
    const plan = { bind: [{ src: "333:9502", prop: "content", path: "news.nope" }] } as never;
    const r = await analyzeBindings({ ir: newsGrid(), theme, data: newsData(), plan });
    expect(r.unresolved).toContain("news.nope");
  });

  it("aligns a run to a window of the list when each card's copy differs", async () => {
    // Make the three trailing cards' copy distinct, as a real design would have it.
    const ir = newsGrid();
    const cards = ["333:9708", "333:9723", "333:9738"];
    const texts: string[][] = [];
    const find = (n: any, id: string): any => (n.id === id ? n : n.children?.map((c: any) => find(c, id)).find(Boolean));
    cards.forEach((id, i) => {
      const own: string[] = [];
      const walk = (n: any): void => {
        if (n.text) {
          n.text.characters = `${n.text.characters} #${i}`;
          own.push(n.text.characters);
        }
        n.children?.forEach(walk);
      };
      walk(find(ir.root, id));
      texts.push(own);
    });

    // Put each card's copy at items[3..6], under the keys a CMS would use.
    const keys = ["headline", "summary", "date"];
    const items = Array.from({ length: 6 }, (_, i) => ({ headline: `filler ${i}`, summary: `filler ${i}`, date: `filler ${i}` }));
    texts.forEach((own, i) => keys.forEach((k, j) => ((items[3 + i] as any)[k] = own[j])));

    const r = await analyzeBindings({ ir, theme, data: { news: { items } } });
    const repeat = r.suggestions.find((s) => s.kind === "collapse");

    expect(repeat?.basis).toBe("aligned");
    expect(repeat?.entry).toMatchObject({ over: "news.items", slice: [3, 6] });
    expect((repeat?.entry as { fields: unknown[] }).fields).toHaveLength(3);
  });

  it("renders the bound tree against the data", async () => {
    const first = await analyzeBindings({ ir: newsGrid(), theme, data: newsData() });
    const plan = {
      bind: first.suggestions.filter((s) => s.kind === "bind").map((s) => s.entry),
      collapse: first.suggestions.filter((s) => s.kind === "collapse").map((s) => s.entry),
    } as never;

    const r = await analyzeBindings({ ir: newsGrid(), theme, data: newsData(), plan, render: true });
    expect(r.html).toContain("Chris Jordan saw it through late on");
  });
});
