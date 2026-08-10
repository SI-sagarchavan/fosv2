import { describe, expect, it } from "vitest";
import { resolveNode } from "../src/resolve/style.js";

describe("resolveNode", () => {
  it("maps gap token to var(), never inlined px", () => {
    const r = resolveNode({ direction: "column", gap: "space.4" });
    expect(r.style["--gap-base"]).toBe("var(--fos-space-4)");
    expect(r.style.gap).toBe("var(--gap-base)");
    expect(JSON.stringify(r.style)).not.toContain("16px");
  });

  it("marks raw size values with data-fos-raw", () => {
    const r = resolveNode({
      size: { w: { raw: 28, _unbound: true }, h: { raw: 28, _unbound: true } },
    });
    expect(r.style["--w-base"]).toBe("28px");
    expect(r.style["--h-base"]).toBe("28px");
    expect(r.dataAttrs["data-fos-raw"]).toContain("size.w");
    expect(r.dataAttrs["data-fos-raw"]).toContain("size.h");
  });

  it("maps size.w full on a ROW flex child to flex:1 1 0", () => {
    const r = resolveNode({ size: { w: "full" } }, { flexChild: true, flexRow: true });
    expect(r.style.flex).toBe("1 1 0");
    expect(r.style.width).toBeUndefined();
  });

  it("maps size.w full on a COLUMN flex child to width 100%", () => {
    // `flex: 1 1 0` in a column sizes the MAIN axis and zeroes the child's
    // height — that is what collapsed the news card's 16:9 thumbnail.
    const r = resolveNode({ size: { w: "full" } }, { flexChild: true, flexRow: false });
    expect(r.style.width).toBe("100%");
    expect(r.style.flex).toBeUndefined();
  });

  it("maps size.w full outside flex to width 100%", () => {
    const r = resolveNode({ size: { w: "full" } });
    expect(r.style.width).toBe("100%");
  });

  it("maps ratio 534/605 to aspect-ratio", () => {
    const r = resolveNode({ size: { ratio: "534/605" } });
    expect(r.style.aspectRatio).toBe("534 / 605");
  });

  it("applies surface utility class from the leaf", () => {
    const r = resolveNode({ surface: "surface.card_player" });
    expect(r.className).toContain("fos-surface-card_player");
  });

  it("emits padding from space.px as inline padding vars", () => {
    const r = resolveNode({ space: { px: "space.9", pb: "space.5" } });
    expect(r.style["--px-base"]).toBe("var(--fos-space-9)");
    expect(r.style["--pb-base"]).toBe("var(--fos-space-5)");
  });

  it("does not mark percentages as raw", () => {
    const r = resolveNode({ size: { h: "115%" } });
    expect(r.style["--h-base"]).toBe("115%");
    expect(r.dataAttrs["data-fos-raw"]).toBeUndefined();
  });

  it("Stack maps justify between and align stretch", () => {
    const r = resolveNode({
      direction: "row",
      justify: "between",
      align: "stretch",
    });
    expect(r.style.display).toBe("flex");
    expect(r.style.flexDirection).toBe("row");
    expect(r.style.justifyContent).toBe("space-between");
    expect(r.style.alignItems).toBe("stretch");
  });

  it("clip maps to overflow hidden, and is absent by default", () => {
    // Figma's `clipsContent` on a plain container, not just an Overlay. The
    // fixture card needs it: the row is 235px inside a 227px shell so the cards
    // bleed and get cut, leaving no strip of shell colour showing.
    expect(resolveNode({ clip: true }).style.overflow).toBe("hidden");
    expect(resolveNode({ clip: true }).dataAttrs["data-fos-clip"]).toBe("true");
    expect(resolveNode({}).style.overflow).toBeUndefined();
    // Explicit false must not clip — it is the Figma default, not a missing key.
    expect(resolveNode({ clip: false }).style.overflow).toBeUndefined();
  });

  it("negative token on place is preserved through resolveNode", () => {
    const r = resolveNode({
      place: { anchor: "top-end", offset: { inline: "-space.6", block: "32%" } },
    });
    expect(r.style.insetInlineEnd).toBe("calc(-1 * var(--fos-space-6))");
    expect(r.style.insetBlockStart).toBe("32%");
    expect(r.style.position).toBe("absolute");
  });
});
