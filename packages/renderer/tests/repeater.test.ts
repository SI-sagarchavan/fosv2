/**
 * Repeater — the fragment case.
 *
 * The Videos section is four instances of ONE component (`968a8019`), which is
 * exactly what Repeater exists for: one template, n items from data.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flatTreeSchema, nodeById } from "@fanos/dsl";

const TREE = join(process.cwd(), "../dsl/fixtures/videos-section.json");
const DATA = join(process.cwd(), "fixtures/videos-section.data.json");

const tree = () => flatTreeSchema.parse(JSON.parse(readFileSync(TREE, "utf8")));
const data = () => JSON.parse(readFileSync(DATA, "utf8")) as Record<string, unknown>;

async function markup(): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { Render } = await import("../src/components/Render.js");
  return renderToStaticMarkup(
    createElement(Render, { tree: tree(), data: data(), width: 1366 } as never),
  );
}

describe("Repeater", () => {
  it("emits one copy of its children per data item", async () => {
    const html = await markup();
    const items = (data().section as { videos: unknown[] }).videos;
    expect(items).toHaveLength(4);
    expect(html.match(/data-fos-repeat="/g)).toHaveLength(4);
    // The card template appears once per item, not once in the tree.
    expect(html.match(/data-fos-id="card"/g)).toHaveLength(4);
  });

  it("binds each item into its own scope", async () => {
    const html = await markup();
    for (const v of (data().section as { videos: { title: string }[] }).videos) {
      expect(html).toContain(v.title.replace(/'/g, "&#x27;"));
    }
  });

  it("adds no box of its own — `display: contents` keeps the flex flow intact", async () => {
    // A Repeater under a Stack must place its children directly into that flex
    // flow; a real wrapper element would become the flex item instead.
    expect(await markup()).toContain("display:contents");
  });

  it("is a fragment, so its children are flex items of the Repeater's PARENT", async () => {
    // `row` is a horizontal Stack, so the card must not carry place.anchor —
    // the validator's S6 resolves through the fragment to find that out.
    expect(nodeById(tree(), "card")!.props.place).toBeUndefined();
  });

  it("respects limit", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { Render } = await import("../src/components/Render.js");
    const t = tree();
    (nodeById(t, "videos")!.props as Record<string, unknown>).limit = 2;
    const html = renderToStaticMarkup(
      createElement(Render, { tree: t, data: data(), width: 1366 } as never),
    );
    expect(html.match(/data-fos-repeat="/g)).toHaveLength(2);
  });
});
