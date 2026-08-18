import { describe, expect, it } from "vitest";
import { ANCHORS, type Anchor } from "@fanos/dsl";
import { resolveAnchor } from "../src/resolve/anchor.js";

type OffsetCase =
  | { name: "none"; offset?: undefined }
  | { name: "block only"; offset: { block: string } }
  | { name: "inline only"; offset: { inline: string } }
  | { name: "both"; offset: { block: string; inline: string } };

const OFFSET_CASES: OffsetCase[] = [
  { name: "none" },
  { name: "block only", offset: { block: "space.4" } },
  { name: "inline only", offset: { inline: "space.4" } },
  { name: "both", offset: { block: "space.4", inline: "space.2" } },
];

const VALUE_KINDS = [
  { name: "token", block: "space.4", inline: "space.2", blockCss: "var(--fos-space-4)", inlineCss: "var(--fos-space-2)" },
  {
    name: "percent",
    block: "32%",
    inline: "10%",
    blockCss: "32%",
    inlineCss: "10%",
  },
  {
    name: "negative token",
    block: "-space.6",
    inline: "-space.6",
    blockCss: "calc(-1 * var(--fos-space-6))",
    inlineCss: "calc(-1 * var(--fos-space-6))",
  },
] as const;

function expectedFor(
  anchor: Anchor,
  kind: (typeof VALUE_KINDS)[number] | null,
  which: OffsetCase["name"],
): Record<string, string> {
  const block =
    which === "none" || which === "inline only" ? undefined : kind?.blockCss;
  const inline =
    which === "none" || which === "block only" ? undefined : kind?.inlineCss;

  const base: Record<string, string> = { position: "absolute" };

  const set = (k: string, edge: "start" | "end" | "center" | "both", off: string | undefined) => {
    if (edge === "start") base[k === "block" ? "insetBlockStart" : "insetInlineStart"] = off ?? "0";
    else if (edge === "end") base[k === "block" ? "insetBlockEnd" : "insetInlineEnd"] = off ?? "0";
    else if (edge === "center")
      base[k === "block" ? "insetBlockStart" : "insetInlineStart"] = off
        ? `calc(50% + ${off})`
        : "50%";
    else if (edge === "both") {
      base[k === "block" ? "insetBlockStart" : "insetInlineStart"] = off ?? "0";
      base[k === "block" ? "insetBlockEnd" : "insetInlineEnd"] = off ?? "0";
    }
  };

  const axes: Record<Anchor, { block: "start" | "end" | "center" | "both"; inline: "start" | "end" | "center" | "both" }> = {
    fill: { block: "both", inline: "both" },
    "top-start": { block: "start", inline: "start" },
    "top-center": { block: "start", inline: "center" },
    "top-end": { block: "start", inline: "end" },
    "top-fill": { block: "start", inline: "both" },
    "mid-start": { block: "center", inline: "start" },
    center: { block: "center", inline: "center" },
    "mid-end": { block: "center", inline: "end" },
    "mid-fill": { block: "center", inline: "both" },
    "bottom-start": { block: "end", inline: "start" },
    "bottom-center": { block: "end", inline: "center" },
    "bottom-end": { block: "end", inline: "end" },
    "bottom-fill": { block: "end", inline: "both" },
  };

  const a = axes[anchor];
  set("block", a.block, block);
  set("inline", a.inline, inline);

  const tx = a.inline === "center";
  const ty = a.block === "center";
  if (tx && ty) base.transform = "translate(-50%, -50%)";
  else if (tx) base.transform = "translateX(-50%)";
  else if (ty) base.transform = "translateY(-50%)";

  return base;
}

describe("resolveAnchor exhaustive table", () => {
  for (const anchor of ANCHORS) {
    describe(anchor, () => {
      for (const offsetCase of OFFSET_CASES) {
        for (const kind of VALUE_KINDS) {
          // Skip value-kind variants when the offset case has no offset.
          if (offsetCase.name === "none" && kind.name !== "token") continue;

          const offset =
            offsetCase.name === "none"
              ? undefined
              : offsetCase.name === "block only"
                ? { block: kind.block }
                : offsetCase.name === "inline only"
                  ? { inline: kind.inline }
                  : { block: kind.block, inline: kind.inline };

          it(`${offsetCase.name} × ${kind.name}`, () => {
            const got = resolveAnchor({ anchor, offset });
            const exp = expectedFor(
              anchor,
              offsetCase.name === "none" ? null : kind,
              offsetCase.name,
            );
            expect(got).toEqual(exp);
          });
        }
      }
    });
  }
});

/**
 * Version skew, which is normal rather than exceptional: a tree is a stored
 * artifact and the renderer that draws it can be older than the compiler that
 * wrote it. This used to throw and take the whole page down.
 */
describe("resolveAnchor with an anchor from the future", () => {
  it("places the node at top-start rather than throwing", () => {
    const got = resolveAnchor({
      anchor: "corner-swirl" as Anchor,
      offset: { block: "space.4" },
    });
    expect(got).toEqual({
      position: "absolute",
      insetBlockStart: "var(--fos-space-4)",
      insetInlineStart: "0",
    });
  });
});

describe("resolveAnchor fixture cases", () => {
  it("cutout bottom-center with no offset", () => {
    expect(resolveAnchor({ anchor: "bottom-center" })).toEqual({
      position: "absolute",
      insetBlockEnd: "0",
      insetInlineStart: "50%",
      transform: "translateX(-50%)",
    });
  });

  it("badges top-end with block percent and negative inline token", () => {
    expect(
      resolveAnchor({
        anchor: "top-end",
        offset: { block: "32%", inline: "-space.6" },
      }),
    ).toEqual({
      position: "absolute",
      insetBlockStart: "32%",
      insetInlineEnd: "calc(-1 * var(--fos-space-6))",
    });
  });

  it("role mid-start with inline space.4", () => {
    expect(
      resolveAnchor({
        anchor: "mid-start",
        offset: { inline: "space.4" },
      }),
    ).toEqual({
      position: "absolute",
      insetBlockStart: "50%",
      insetInlineStart: "var(--fos-space-4)",
      transform: "translateY(-50%)",
    });
  });

  it("never emits physical top/left/right/bottom", () => {
    for (const anchor of ANCHORS) {
      const style = resolveAnchor({
        anchor,
        offset: { block: "space.2", inline: "-space.6" },
      });
      for (const phys of ["top", "left", "right", "bottom"]) {
        expect(style[phys]).toBeUndefined();
      }
    }
  });

  it("fill with no offset uses both axes at 0", () => {
    expect(resolveAnchor({ anchor: "fill" })).toEqual({
      position: "absolute",
      insetBlockStart: "0",
      insetBlockEnd: "0",
      insetInlineStart: "0",
      insetInlineEnd: "0",
    });
  });

  it("place.z is an explicit override only", () => {
    expect(resolveAnchor({ anchor: "center", z: 3 }).zIndex).toBe("3");
  });
});
