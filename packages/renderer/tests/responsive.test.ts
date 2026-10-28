/**
 * `Resp<T>` in a real browser — does a breakpoint value ever take effect?
 *
 * It did not. A responsive prop was emitted as inline
 * `flex-direction: var(--flex-direction-base)`, and the md/lg promotion lived in
 * a class rule inside a media query. Inline style beats any class rule, so every
 * `Resp` value stayed at its base at every width: a `{ base: "column", lg:
 * "row" }` section stacked at 1440px. Compiled Figma frames never noticed —
 * they carry single values — and the markup looks right, so only measuring
 * boxes at two viewports can catch it. Found composing a section from scratch.
 *
 * Skipped when Playwright's Chromium is not installed.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import type { FlatTree } from "@fanos/dsl";
import { emitCss, loadTheme, LOCAL_ASSET_CONTEXT } from "@fanos/tokens";
import { closeBrowser, measureNodeBoxes } from "../src/harness/renderToPng.js";
import { FONT_FACE_CSS } from "../src/fonts.js";

const THEME = join(process.cwd(), "../tokens/fixtures/southern-brave.json");
const FONT = join(process.cwd(), "public/fonts/bakbak-one-400.woff2");

async function browserAvailable(): Promise<boolean> {
  if (!existsSync(FONT)) return false;
  try {
    const b = await chromium.launch({ headless: true });
    await b.close();
    return true;
  } catch {
    return false;
  }
}

const enabled = await browserAvailable();

const raw = (n: number) => ({ raw: n, _unbound: true });
const box = (id: string, idx: number) => ({
  id, parent: "row", idx, type: "Box", src: `synthetic:${id}`,
  props: { size: { w: raw(100), h: raw(50) } },
});

/** Stacks on a phone, a row from tablet up, with a gap that grows at desktop. */
const tree: FlatTree = {
  schemaVersion: "1.0.0",
  nodes: [
    {
      id: "row", parent: null, idx: 0, type: "Stack", src: "synthetic:row",
      props: {
        direction: { base: "column", md: "row" },
        gap: { base: "space.2", lg: "space.8" },
        space: { p: { base: "space.0", lg: "space.4" } },
      },
    },
    box("a", 0),
    box("b", 1),
  ],
};

async function at(viewport: number) {
  const { css } = emitCss(loadTheme(THEME), { assets: LOCAL_ASSET_CONTEXT, scope: "root" });
  const boxes = await measureNodeBoxes(tree, { themeCss: css, fontCss: FONT_FACE_CSS, width: viewport, viewport });
  const get = (id: string) => boxes.find((b) => b.id === id)!;
  return { a: get("a"), b: get("b") };
}

describe.skipIf(!enabled)("Resp values at their breakpoints", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  it("uses the base value below md", async () => {
    const { a, b } = await at(390);
    expect(b.x).toBe(a.x);
    expect(b.y).toBe(a.y + 50 + 8);
  });

  it("promotes md from 768px, keeping base where md says nothing", async () => {
    const { a, b } = await at(900);
    expect(b.y).toBe(a.y);
    expect(b.x).toBe(a.x + 100 + 8);
  });

  it("promotes lg from 1280px, falling back through md to base", async () => {
    const { a, b } = await at(1440);
    expect(b.y).toBe(a.y);
    expect(b.x).toBe(a.x + 100 + 32);
    expect(a.x).toBe(16);
  });
});
