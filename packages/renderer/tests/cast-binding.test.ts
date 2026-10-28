/**
 * The news grid drawn from a real CAST flow response.
 *
 * Same compiled Figma frame as `news-grid.test.ts`, bound by the CAST plan
 * instead of the hand-shaped one, and rendered against
 * `{ news: fromCastFlow(response) }` — the Delhi Capitals CMS Listing payload
 * exactly as `/cast/api/flow/<workflow>` returned it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyBindingPlan, flatTreeSchema, fromCastFlow, type BindingPlan, type FlatTree } from "@fanos/dsl";

const DSL = join(process.cwd(), "../dsl/fixtures");
const json = (path: string): unknown => JSON.parse(readFileSync(join(DSL, path), "utf8"));

const ORIGIN = "https://dc.surface.fan-os.net";
const response = () => json("cast/dc-news.flow.json");
const items = () => fromCastFlow(response()).items as Array<Record<string, string | number | null>>;
const tree = (): FlatTree =>
  applyBindingPlan(flatTreeSchema.parse(json("news-grid.json")), json("bindings/news-grid.cast.plan.json") as BindingPlan).tree;

async function markup(t: FlatTree = tree(), data: Record<string, unknown> = { news: fromCastFlow(response()) }): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { Render } = await import("../src/components/Render.js");
  return renderToStaticMarkup(createElement(Render, { tree: t, data, origin: ORIGIN, width: 1366 } as never));
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

describe("the news grid against a CAST payload", () => {
  it("draws the six cards the design has room for, in payload order", async () => {
    const html = await markup();
    for (const item of items().slice(0, 6)) expect(html).toContain(esc(String(item.title)));
    for (const item of items().slice(6)) expect(html).not.toContain(esc(String(item.title)));
  });

  it("formats dates the way the mock-up shows them", async () => {
    const html = await markup();
    expect(html).toContain("Oct 21, 2026");
    expect(html).not.toContain("2026-10-21T10:29:00.000Z");
  });

  it("asks the CDN for the crop each box needs, on the tenant's host", async () => {
    const srcs = [...(await markup()).matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
    const file = (i: number) => String(items()[i]!.thumbnail_image).split("{{RATIO}}-")[1]!.replace(/&/g, "&amp;");
    expect(srcs).toEqual([
      `${ORIGIN}/static-assets/media/16-9-${file(0)}`,
      `${ORIGIN}/static-assets/media/1-1-${file(1)}`,
      `${ORIGIN}/static-assets/media/1-1-${file(2)}`,
      `${ORIGIN}/static-assets/media/1-1-${file(3)}`,
      `${ORIGIN}/static-assets/media/1-1-${file(4)}`,
      `${ORIGIN}/static-assets/media/1-1-${file(5)}`,
    ]);
  });

  it("lets a fill image's ratio pick the crop without resizing its box", async () => {
    const html = await markup();
    const lead = html.match(/<div[^>]*data-fos-id="image"[^>]*>/)![0];
    expect(lead).not.toContain("aspect-ratio");
    expect(html).toContain("/static-assets/media/16-9-");
  });

  it("leaves no ref, slot or null on the page", async () => {
    const html = await markup();
    expect(html).not.toMatch(/\{[A-Za-z_][\w.]*( \|[^}]*)?\}/);
    expect(html).not.toContain("{{RATIO}}");
    expect(html).not.toMatch(/>null</);
  });
});

describe("when", () => {
  /**
   * A one-card listing with the two switches fanxp's extension molecule
   * hand-codes: a play badge only on videos, a duration only when there is one.
   */
  const card: FlatTree = {
    schemaVersion: "0.1.0",
    nodes: [
      { id: "list", parent: null, idx: 0, type: "Stack", src: "synthetic:list", props: {} },
      { id: "each", parent: "list", idx: 0, type: "Repeater", src: "synthetic:each", props: { over: "news.items", as: "item" } },
      { id: "card", parent: "each", idx: 0, type: "Stack", src: "synthetic:card", props: { testId: "card" } },
      { id: "title", parent: "card", idx: 0, type: "Text", src: "synthetic:title", props: { content: "{item.title}", style: "type.md_regular" } },
      {
        id: "badge", parent: "card", idx: 1, type: "Text", src: "synthetic:badge",
        props: { content: "VIDEO", style: "type.md_regular", when: { path: "item.asset_type_id", eq: 4 } },
      },
      {
        id: "duration", parent: "card", idx: 2, type: "Text", src: "synthetic:duration",
        props: { content: "{item.duration}", style: "type.md_regular", when: [{ path: "item.asset_type_id", eq: 4 }, { path: "item.duration", exists: true }] },
      },
    ],
  };

  it("links each card to its story on the tenant", async () => {
    const linked: FlatTree = {
      ...card,
      nodes: [
        ...card.nodes,
        {
          id: "read", parent: "card", idx: 3, type: "Button", src: "synthetic:read",
          props: { label: "Read", variant: "link", styleN: 1, size: "sm", action: { kind: "navigate", href: "{item.detail_url}" } },
        },
      ],
    };
    const html = await markup(linked);
    expect(html).toContain(`href="${ORIGIN}${items()[0]!.detail_url}"`);
  });

  it("draws the badge on videos and the duration only where there is one", async () => {
    const html = await markup(card);
    const videos = items().filter((i) => i.asset_type_id === 4);
    expect(html.match(/>VIDEO</g)).toHaveLength(videos.length);
    expect(html.match(/data-fos-id="duration"/g)).toHaveLength(videos.filter((v) => v.duration).length);
    expect(html).toContain(">04:11 Mins<");
  });
});
