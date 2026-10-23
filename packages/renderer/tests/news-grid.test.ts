/**
 * The news grid, bound and collapsed — the whole point, end to end.
 *
 * `news-grid.bound.json` is the compiled section after two separate jobs that
 * are easy to conflate and must not be:
 *
 *   BINDING     removed the static data. Every card's copy is now a path into
 *               `news.items`, whether or not that card repeats.
 *   COLLAPSING  removed the duplicate structure. Only the trailing column
 *               genuinely drew one card three times, so only it became a
 *               Repeater. The lead and the two feature cards are three
 *               different designs bound by index — collapsing them would have
 *               been an optimisation looking for a repeat that is not there.
 *
 * The result is an index-tiered grid: ONE list of six articles, drawn as a
 * lead, two features and three briefs, where the tier is decided by position.
 *
 * The binding assertion below is the one that would have caught a real bug.
 * `{news.items[0].headline}` is schema-legal, geometry-neutral, and renders the
 * literal braces onto the page — neither @fanos/dsl nor @fanos/conform can see
 * it. Only resolving every path against the data document can.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flatTreeSchema, nodeById, type FlatTree } from "@fanos/dsl";

const TREE = join(process.cwd(), "../dsl/fixtures/news-grid.bound.json");
const DATA = join(process.cwd(), "fixtures/news-grid.data.json");

const tree = (): FlatTree => flatTreeSchema.parse(JSON.parse(readFileSync(TREE, "utf8")));
const data = () => JSON.parse(readFileSync(DATA, "utf8")) as Record<string, unknown>;
const items = () => (data().news as { items: Article[] }).items;

interface Article {
  headline: string;
  summary: string;
  date: string;
  thumbnail: string;
}

async function markup(): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { Render } = await import("../src/components/Render.js");
  return renderToStaticMarkup(
    createElement(Render, { tree: tree(), data: data(), width: 1366 } as never),
  );
}

/** Mirrors the renderer's own matcher, so this cannot be laxer than it. */
const TOKEN_RE = /\{([A-Za-z_][A-Za-z0-9_.]*)\}/g;
/** Braces the matcher above would NOT accept — `items[0]`, `a-b`, `x y`. */
const MALFORMED_RE = /\{[^}]*[^A-Za-z0-9_.{}][^}]*\}/g;

function lookup(root: unknown, path: string): unknown {
  let cur = root;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** The alias a Repeater introduces resolves against an ITEM, not the document. */
function scopesOf(t: FlatTree): Map<string, unknown> {
  const scopes = new Map<string, unknown>();
  for (const node of t.nodes) {
    if (node.type !== "Repeater") continue;
    const { over, as, slice } = node.props as { over: string; as: string; slice?: [number, number] };
    const list = lookup(data(), over);
    if (!Array.isArray(list)) continue;
    const windowed = slice ? list.slice(slice[0], slice[1]) : list;
    scopes.set(as, windowed[0]);
  }
  return scopes;
}

describe("the bound tree", () => {
  it("carries no literal copy at all", () => {
    const literals = tree()
      .nodes.filter((n) => n.type === "Text")
      .filter((n) => !String(n.props.content ?? "").includes("{"));
    expect(literals.map((n) => n.id)).toEqual([]);
  });

  it("kept one Repeater — only the trailing column actually repeats", () => {
    const repeaters = tree().nodes.filter((n) => n.type === "Repeater");
    expect(repeaters).toHaveLength(1);
    expect(repeaters[0]!.props).toMatchObject({ over: "news.items", as: "article", slice: [3, 6] });
  });

  it("is 50 nodes, down from the 69 the compiler emitted", () => {
    expect(tree().nodes).toHaveLength(50);
  });

  /**
   * THE GATE. Every `{path}` in the tree reaches a real value.
   *
   * Paths under a Repeater resolve against one item; everything else against
   * the document. A path that resolves to `undefined` renders as literal braces
   * on a shipped page, and no other check in the pipeline can see it.
   */
  it("every binding resolves against the data document", () => {
    const t = tree();
    const scopes = scopesOf(t);
    const byId = new Map(t.nodes.map((n) => [n.id, n]));
    const parentOf = (id: string): string | null => byId.get(id)?.parent ?? null;

    /** The Repeater alias in scope for a node, if it sits under one. */
    const aliasFor = (id: string): string | undefined => {
      for (let cur = parentOf(id); cur !== null; cur = parentOf(cur)) {
        const node = byId.get(cur);
        if (node?.type === "Repeater") return (node.props as { as: string }).as;
      }
      return undefined;
    };

    const unresolved: string[] = [];
    const malformed: string[] = [];
    let checked = 0;

    for (const node of t.nodes) {
      for (const [prop, value] of Object.entries(node.props)) {
        if (typeof value !== "string" || !value.includes("{")) continue;

        for (const hit of value.matchAll(MALFORMED_RE)) {
          malformed.push(`${node.id}.${prop} ${hit[0]}`);
        }

        const alias = aliasFor(node.id);
        for (const hit of value.matchAll(TOKEN_RE)) {
          checked += 1;
          const path = hit[1]!;
          const head = path.split(".")[0]!;
          const root = alias !== undefined && head === alias ? { [alias]: scopes.get(alias) } : data();
          if (lookup(root, path) === undefined) unresolved.push(`${node.id}.${prop} {${path}}`);
        }
      }
    }

    expect(malformed).toEqual([]);
    expect(unresolved).toEqual([]);
    expect(checked).toBe(18);
  });

  it("catches the bug it exists for — `items[0]` is legal and unresolvable", () => {
    expect("{news.items[0].headline}".match(MALFORMED_RE)).not.toBeNull();
    expect(lookup(data(), "news.items[0].headline")).toBeUndefined();
    // …while the dotted form the renderer actually understands does resolve.
    expect(lookup(data(), "news.items.0.headline")).toBe(items()[0]!.headline);
  });
});

describe("the rendered page", () => {
  it("draws six articles from one list, tiered by position", async () => {
    const html = await markup();
    // `&` first: escaping the apostrophe INTRODUCES an ampersand, so the other
    // order double-escapes it and the assertion looks for text nobody emits.
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;");
    for (const article of items()) {
      expect(html).toContain(esc(article.headline));
    }
  });

  it("draws the trailing column from the slice, not the whole list", async () => {
    const html = await markup();
    // Three repetitions, one per item in [3, 6) — not six.
    expect(html.match(/data-fos-repeat="/g)).toHaveLength(3);
  });

  it("leaves no unresolved braces on the page", async () => {
    expect(await markup()).not.toMatch(/\{[A-Za-z_][A-Za-z0-9_.]*\}/);
  });

  it("binds the section chrome too, not just the cards", async () => {
    const html = await markup();
    expect(html).toContain("SOUTH COAST STORIES");
    expect(html).toContain("VIEW MORE");
    expect(nodeById(tree(), "south_coast_stories")!.props.content).toBe("{news.eyebrow}");
  });
});
