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

/**
 * `slice` — the index-tiered grid.
 *
 * One list of articles drawn as a lead, then features, then briefs, where the
 * tier is decided by POSITION. `when` cannot say this: nothing on article #4
 * marks it as a brief except being fourth.
 */
describe("Repeater.slice", () => {
  async function withProps(props: Record<string, unknown>): Promise<string> {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { Render } = await import("../src/components/Render.js");
    const t = tree();
    Object.assign(nodeById(t, "videos")!.props as Record<string, unknown>, props);
    return renderToStaticMarkup(createElement(Render, { tree: t, data: data(), width: 1366 } as never));
  }

  const titles = () => (data().section as { videos: { title: string }[] }).videos.map((v) => v.title);
  const esc = (s: string) => s.replace(/'/g, "&#x27;");

  it("draws its window and nothing else", async () => {
    const html = await withProps({ slice: [1, 3] });
    expect(html.match(/data-fos-repeat="/g)).toHaveLength(2);
    expect(html).toContain(esc(titles()[1]!));
    expect(html).toContain(esc(titles()[2]!));
    expect(html).not.toContain(esc(titles()[0]!));
    expect(html).not.toContain(esc(titles()[3]!));
  });

  it("is end-exclusive", async () => {
    expect((await withProps({ slice: [0, 1] })).match(/data-fos-repeat="/g)).toHaveLength(1);
  });

  /**
   * A CMS that returns four items where the design assumed six should render a
   * short section, not a blank one. `Array.prototype.slice` clamps for us; this
   * pins that we rely on it.
   */
  it("clamps a window that runs past the end of the list", async () => {
    expect((await withProps({ slice: [2, 99] })).match(/data-fos-repeat="/g)).toHaveLength(2);
  });

  it("wins over limit, which S13 forbids alongside it anyway", async () => {
    expect((await withProps({ slice: [0, 3], limit: 1 })).match(/data-fos-repeat="/g)).toHaveLength(3);
  });
});
