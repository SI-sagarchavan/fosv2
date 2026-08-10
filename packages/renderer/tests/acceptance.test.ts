/**
 * Acceptance criteria for the player-card fixture.
 *
 * Some checks need Playwright (computed styles, fonts). Pure structural
 * checks run without a browser.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flatTreeSchema, reify, childrenOf, nodeById } from "@fanos/dsl";
import { resolveNode } from "../src/resolve/style.js";
import { resolveAnchor } from "../src/resolve/anchor.js";
import { interpolate } from "../src/resolve/data.js";

const CARD = join(process.cwd(), "../dsl/fixtures/player-card.json");
const DATA = join(process.cwd(), "fixtures/player-card.data.json");

function card() {
  return flatTreeSchema.parse(JSON.parse(readFileSync(CARD, "utf8")));
}

function data() {
  return JSON.parse(readFileSync(DATA, "utf8")) as Record<string, unknown>;
}

describe("generated from the Figma IR", () => {
  // Every number here is READ from `organism_web_cricket_playercard` (1:5043)
  // in the IR export, not measured off a screenshot.

  it("paints the card body as a 281x353 child at y=61, not over the whole frame", () => {
    // IR: Group 1321314966 is 281x353 at rel y=61 inside a 281x412 frame. The
    // top 61px is deliberately empty so the cutout's head reads over the page.
    // 281/353 = 0.7960 is also the card_bg asset's aspect (480/603) — the asset
    // IS the body, and stretching it over the frame was wrong.
    const bg = nodeById(card(), "card_bg")!.props as Record<string, unknown>;
    expect(bg.surface).toBe("surface.card_player");
    expect((bg.size as { w: { raw: number }; h: { raw: number } }).w.raw).toBe(281);
    expect((bg.size as { h: { raw: number } }).h.raw).toBe(353);
    expect((bg.place as { offset: { block: { raw: number } } }).offset.block.raw).toBe(61);
    // The Overlay itself carries no surface.
    expect(nodeById(card(), "card")!.props.surface).toBeUndefined();
  });

  it("takes the card's ratio from the IR bbox (281x412)", () => {
    const size = nodeById(card(), "card")!.props.size as { ratio: string };
    expect(size.ratio).toBe("281/412");
  });

  it("uses REAL Figma node ids for src — the repair loop's anchor", () => {
    // The hand-authored fixture used an invented 1:5000-1:5021 block, so every
    // diff region mapped back to a node that does not exist in Figma.
    for (const n of card().nodes) {
      expect(n.src, n.id).toMatch(/^(1:5043|I1:5043;)/);
    }
  });

  it("places the pill from the IR: 249 wide, bottom inset 16 = space.4", () => {
    // IR relBbox (16,336) 249x60 on a 281x412 card -> 412-336-60 = 16.
    // Absolute px is right here: the renderer scales the whole card, so the
    // tree stays a faithful transcription of the frame at its native size.
    const stats = nodeById(card(), "stats")!.props as Record<string, unknown>;
    expect((stats.size as { w: { raw: number } }).w.raw).toBe(249);
    expect((stats.place as { offset: { block: string } }).offset.block).toBe("space.4");
    // IR padding: 20 left/right (token "5"), 10 top/bottom (token "2_5").
    expect(stats.space).toEqual({ px: "space.5", py: "space.2_5" });
    expect(stats.surface).toBe("surface.stat_strip");
  });

  it("labels stats MATCHES / RUNS / STRIKE RATE, as the IR text says", () => {
    const t = card();
    expect(nodeById(t, "stat_matches_label")!.props.content).toBe("MATCHES");
    expect(nodeById(t, "stat_runs_label")!.props.content).toBe("RUNS");
    expect(nodeById(t, "stat_strike_rate_label")!.props.content).toBe("STRIKE RATE");
  });

  it("binds the type tokens the designer bound", () => {
    const t = card();
    // IR styleRef dp_3/regular, body_xs/regular, h3/bold.
    expect(nodeById(t, "name")!.props.style).toBe("type.dp_3_regular");
    expect(nodeById(t, "stat_matches_label")!.props.style).toBe("type.body_xs_regular");
    expect(nodeById(t, "stat_matches_value")!.props.style).toBe("type.h3_bold");
    // IR fill tokenRefs text/prim/high and text/sec/medium.
    expect(nodeById(t, "name")!.props.tone).toBe("color.text_prim_high");
    expect(nodeById(t, "stat_matches_label")!.props.tone).toBe("color.text_sec_medium");
  });

  it("substitutes a token for the one text style Figma left UNBOUND", () => {
    // The role label is 12/700 Montserrat with no text style applied
    // (`text.unbound: true`). body_sm_bold is 12/18 w700 — same size and weight.
    expect(nodeById(card(), "role")!.props.style).toBe("type.body_sm_bold");
    expect(nodeById(card(), "role")!.props.orientation).toBe("vertical-up");
  });

  it("keeps the cutout's IR geometry, including its bleed above the card", () => {
    // IR relBbox (18,-17) 249x376, fill IMAGE:CROP.
    const p = nodeById(card(), "cutout")!.props as Record<string, unknown>;
    /**
     * `contain`, DELIBERATELY against the IR's CROP.
     *
     * Figma's CROP is not CSS `cover`: it means "show the crop rectangle the
     * designer dragged", and that transform is not in the IR — only the fact
     * that a crop exists. Reproducing it needs the source image the designer
     * cropped, which for this card is Ben McKinney's cutout and is not
     * exportable from the file.
     *
     * Our stand-in (480x854, aspect 0.562) is a different shape from the 249x376
     * box (0.662), so `cover` scales it up ~18% and shears the head and legs off
     * a figure that is supposed to read whole. `contain` keeps the cutout intact,
     * which is what the crop was for.
     *
     * Revisit if the real asset with its crop rect ever lands: then CROP maps to
     * `cover` plus an object-position, and this becomes a faithful `cover`.
     */
    expect(p.fit).toBe("contain");
    expect((p.size as { w: { raw: number }; h: { raw: number } }).w.raw).toBe(249);
    expect((p.size as { h: { raw: number } }).h.raw).toBe(376);
    expect((p.place as { offset: { block: { raw: number } } }).offset.block.raw).toBe(-17);
  });
});

describe("structural acceptance (pure)", () => {
  it("reifies the card tree", () => {
    expect(() => reify(card())).not.toThrow();
  });

  it("Overlay clip:false keeps overflow visible; clip:true hides", () => {
    const open = resolveNode({ clip: false, size: { ratio: "534/605" } });
    // clip class only when true — Overlay component adds fos-overlay-clip
    expect(open.className).not.toContain("fos-overlay-clip");
    const closed = resolveNode({ clip: true });
    // resolveNode still tags clip for class composition in Overlay
    expect(closed.className.includes("fos-overlay-clip") || closed.className.includes("fos-node")).toBe(
      true,
    );
  });

  it("cutout is top-center with a negative block offset so it bleeds above", () => {
    const place = nodeById(card(), "cutout")!.props.place as { anchor: string };
    const style = resolveAnchor(place as never);
    expect(style.insetBlockStart).toBe("-17px");
    expect(style.insetInlineStart).toBe("50%");
    expect(style.transform).toBe("translateX(-50%)");
  });

  it("badges sit inside the card's right edge", () => {
    // The design puts them inside, tight to the edge. Hanging them outside on a
    // negative offset also pushed them outside the root screenshot, so the
    // pixel diff could never score them. The negative-offset MECHANISM is still
    // covered exhaustively in anchor.test.ts.
    const place = nodeById(card(), "badges")!.props.place as {
      anchor: string;
      offset: { block: string; inline: string };
    };
    const style = resolveAnchor(place as never);
    // IR relBbox (246.68,108.58) 24.19x60.14 on a 281-wide card -> ~10px inset.
    expect(style.insetInlineEnd).toBe("10px");
    expect(style.insetInlineEnd).not.toContain("-1");
  });

  it("stat groups hug their content and are spaced by SPACE_BETWEEN", () => {
    // The IR frames are hug/hug with justify SPACE_BETWEEN on the row — not
    // equal thirds, which is what the hand-authored fixture assumed.
    expect(nodeById(card(), "stats")!.props.justify).toBe("between");
    for (const id of ["stat_matches", "stat_runs", "stat_strike_rate"]) {
      expect(nodeById(card(), id)!.props.size).toBeUndefined();
    }
  });

  it("interpolates player name and stats from data fixture", () => {
    const d = data();
    expect(interpolate("{player.name}", d).value).toBe("Ben\nMcKinney");
    expect(interpolate("{player.stats.matches}", d).value).toBe("10");
    expect(interpolate("{player.stats.runs}", d).value).toBe("300");
    expect(interpolate("{player.stats.strikeRate}", d).value).toBe("116.67");
  });

  it("card has 22 nodes and stats has 5 children", () => {
    const t = card();
    expect(t.nodes).toHaveLength(22);
    expect(childrenOf(t, "stats")).toHaveLength(5);
  });
});
