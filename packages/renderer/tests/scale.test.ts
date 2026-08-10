/**
 * Uniform scaling of a fixed-aspect card.
 *
 * The player card is a media object, not a fluid layout. Measured on the real
 * pair: the Figma frame is 281px wide with a 36px name (9.25% of width) and the
 * shipped web card is 534px with a ~68px name (8.80%) — the same object at 1.9x.
 *
 * Type tokens are absolute px per breakpoint and correctly do NOT scale with a
 * container, so rendering the card at another size means scaling the whole
 * thing. Without `designWidth` the geometry stretched while the type stayed
 * put, which is what made the card fall apart at every width but 281.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flatTreeSchema } from "@fanos/dsl";

const CARD = join(process.cwd(), "../dsl/fixtures/player-card.json");
const DATA = join(process.cwd(), "fixtures/player-card.data.json");

const tree = () => flatTreeSchema.parse(JSON.parse(readFileSync(CARD, "utf8")));
const data = () => JSON.parse(readFileSync(DATA, "utf8")) as Record<string, unknown>;

async function markup(props: Record<string, unknown>): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { Render } = await import("../src/components/Render.js");
  return renderToStaticMarkup(createElement(Render, { tree: tree(), data: data(), ...props } as never));
}

describe("designWidth", () => {
  it("lays the tree out at its native width and scales the result", async () => {
    const html = await markup({ width: 534, designWidth: 281 });
    expect(html).toContain("data-fos-scaler");
    expect(html).toContain(`scale(${534 / 281})`);
    // Native box inside…
    expect(html).toContain("width:281px");
    // …scaled box outside: 412 * (534/281).
    expect(html).toContain(`height:${Number(((412 * 534) / 281).toFixed(4))}px`);
  });

  it("derives the design height from the root's own ratio", async () => {
    // 281/412 comes straight from the IR bbox, so the wrapper never guesses.
    const html = await markup({ width: 1088, designWidth: 281 });
    const expected = Number(((412 * 1088) / 281).toFixed(4)); // ~1595.6
    expect(html).toContain(`height:${expected}px`);
  });

  it("does not wrap when the render width IS the design width", async () => {
    const html = await markup({ width: 281, designWidth: 281 });
    expect(html).not.toContain("data-fos-scaler");
    expect(html).not.toContain("transform:scale");
  });

  it("does not wrap when designWidth is omitted — fluid components are unaffected", async () => {
    const html = await markup({ width: 534 });
    expect(html).not.toContain("data-fos-scaler");
  });

  it("records the scale factor for the diff harness to read back", async () => {
    expect(await markup({ width: 562, designWidth: 281 })).toContain('data-fos-scale="2.0000"');
  });
});
