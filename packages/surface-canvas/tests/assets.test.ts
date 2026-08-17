/**
 * Uploaded background assets: parse, name, bind, stamp onto the IR.
 */
import { describe, expect, it } from "vitest";
import {
  applyAssetBindings,
  bindingKey,
  parseBindings,
  placementsFromIr,
  removeBinding,
  renameBinding,
  retargetBinding,
  serializeBindings,
  setBindingFit,
  suggestAssetName,
  targetOptions,
  upsertBinding,
} from "../src/assets.js";
import {
  assetRef,
  parseFrameIRDocument,
  type AssetBinding,
  type FrameIRDocument,
  type FrameIRNode,
} from "../src/ir/schema.js";

const header: AssetBinding = {
  role: "background",
  name: "top_header",
  imageHash: "hash-a",
  fileName: "Top Header@2x.png",
  width: 2732,
  height: 836,
  targetId: "1:2",
  targetName: "Top Header",
  fit: "cover",
  mapping: "auto",
};

function node(over: Partial<FrameIRNode> & Pick<FrameIRNode, "id" | "name">): FrameIRNode {
  return {
    type: "FRAME",
    layout: {
      mode: "none",
      gap: null,
      padding: {
        top: { value: 0, unbound: false },
        right: { value: 0, unbound: false },
        bottom: { value: 0, unbound: false },
        left: { value: 0, unbound: false },
      },
      align: null,
      justify: null,
      wrap: false,
      sizing: { w: "fixed", h: "fixed" },
      positioning: "auto",
    },
    geometry: {
      bbox: { x: 0, y: 0, w: 100, h: 100 },
      relBbox: { x: 0, y: 0, w: 100, h: 100 },
      rotation: 0,
      aspect: 1,
      aspectBucket: "square",
    },
    fill: null,
    stroke: null,
    radius: null,
    effects: [],
    opacity: 1,
    clipsContent: false,
    structuralSignature: "s",
    canonicalSignature: "c",
    repeatedSiblings: 1,
    depth: 0,
    childCount: over.children?.length ?? 0,
    children: [],
    ...over,
  };
}

function doc(root: FrameIRNode, irVersion: FrameIRDocument["irVersion"] = "1.6.0"): FrameIRDocument {
  return {
    fileKey: null,
    fileName: "f",
    pageName: "p",
    rootNodeId: root.id,
    extractedAt: "2026-01-01T00:00:00.000Z",
    irVersion,
    breakpointHint: 1366,
    root,
    assets: [],
  };
}

describe("suggestAssetName", () => {
  it("slugs a filename, dropping the extension and the export scale", () => {
    expect(suggestAssetName("Top Header@2x.png")).toBe("top_header");
    expect(suggestAssetName("listing pattern.PNG")).toBe("listing_pattern");
  });

  it("uniques against names already taken", () => {
    expect(suggestAssetName("plate.png", new Set(["plate"]))).toBe("plate_2");
  });
});

describe("identity is the image hash", () => {
  /**
   * The bytes ARE the asset. Not the name, which is editable, and not the
   * target, which can be re-pointed. Figma hashes image content, so dropping
   * the same file twice must re-point rather than produce two copies.
   */
  it("re-dropping the same image replaces rather than duplicates", () => {
    const moved = { ...header, targetId: "1:9", targetName: "Hero" };
    expect(upsertBinding([header], moved)).toEqual([moved]);
  });

  it("keeps a second, different image on the same target", () => {
    const other = { ...header, imageHash: "hash-b", name: "pattern" };
    expect(upsertBinding([header], other)).toEqual([header, other]);
  });

  it("removes by hash", () => {
    expect(bindingKey(header)).toBe("hash-a");
    expect(removeBinding([header], "hash-a")).toEqual([]);
  });
});

describe("parse / serialize", () => {
  it("round-trips a list and drops junk", () => {
    expect(parseBindings(serializeBindings([header]))).toEqual([header]);
    expect(parseBindings("")).toEqual([]);
    expect(parseBindings("not-json")).toEqual([]);
    expect(parseBindings(JSON.stringify([{ role: "nope" }]))).toEqual([]);
  });

  /**
   * A 1.5.0 binding names Figma layers and has no uploaded bytes behind it.
   * There is nothing to migrate, so it is dropped — quietly, because the
   * alternative is a plugin that refuses to open a file saved last week.
   */
  it("drops a binding from the marking era rather than choking on it", () => {
    const legacy = JSON.stringify([
      {
        role: "background",
        name: "old",
        sources: [{ id: "1:10", name: "plate" }],
        targetId: "1:2",
        targetName: "Top Header",
      },
    ]);
    expect(parseBindings(legacy)).toEqual([]);
  });
});

describe("renameBinding", () => {
  it("renames the asset it names and leaves the others alone", () => {
    const other = { ...header, imageHash: "hash-b", name: "pattern" };
    expect(renameBinding([header, other], "hash-a", "hero_bg")).toEqual({
      ok: true,
      bindings: [{ ...header, name: "hero_bg" }, other],
    });
  });

  it("refuses a name that is not addressable as a token", () => {
    for (const bad of ["Top Header", "top-header", "_leading", "trailing_", ""]) {
      expect(renameBinding([header], "hash-a", bad).ok, `expected ${bad} refused`).toBe(false);
    }
  });

  it("refuses a collision with another asset", () => {
    const other = { ...header, imageHash: "hash-b", name: "pattern" };
    const result = renameBinding([header, other], "hash-a", "pattern");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("pattern");
  });
});

describe("retargetBinding", () => {
  /**
   * A guess the designer has corrected is no longer a guess. The distinction
   * matters later: a wrong region painted by the matcher and one painted by a
   * person are diagnosed differently.
   */
  it("records the mapping as manual", () => {
    const [moved] = retargetBinding([header], "hash-a", { id: "1:9", name: "Hero" });
    expect(moved).toMatchObject({ targetId: "1:9", targetName: "Hero", mapping: "manual" });
  });
});

describe("setBindingFit", () => {
  it("sets fit on one asset only", () => {
    const other = { ...header, imageHash: "hash-b", name: "pattern" };
    expect(setBindingFit([header, other], "hash-a", "repeat")).toEqual([
      { ...header, fit: "repeat" },
      other,
    ]);
  });
});

describe("applyAssetBindings", () => {
  it("stamps the target and the document list", () => {
    const tree = doc(node({ id: "1:2", name: "Top Header" }));
    const stamped = applyAssetBindings(tree, [header]);
    expect(stamped.assets).toEqual([header]);
    expect(stamped.root.background).toEqual(header);
  });

  it("drops a binding whose target is not in the tree", () => {
    const tree = doc(node({ id: "9:9", name: "Elsewhere" }));
    expect(applyAssetBindings(tree, [header]).assets).toEqual([]);
  });

  /** A stamp from the marking era is stripped on parse, not validated. */
  it("parses a document still carrying marking-era stamps", () => {
    const legacy = {
      ...doc(node({ id: "1:2", name: "Top Header" }), "1.5.0"),
      root: {
        ...node({ id: "1:2", name: "Top Header" }),
        background: { role: "background", name: "old", sources: [{ id: "1:3", name: "p" }] },
      },
    };
    expect(parseFrameIRDocument(legacy).root.background).toBeUndefined();
  });
});

describe("placementsFromIr", () => {
  it("reports an asset as covering the element it paints", () => {
    const tree = node({ id: "1:2", name: "Top Header" });
    expect(placementsFromIr(tree, [header])["hash-a"]).toMatchObject({ covers: true });
  });

  it("omits an asset whose target has gone", () => {
    expect(placementsFromIr(node({ id: "9:9", name: "Other" }), [header])).toEqual({});
  });
});

/**
 * Target options: the ancestors an asset could be re-pointed at.
 *
 * Ancestors rather than the canvas selection, so the offer is stable whatever
 * is selected and cannot vanish because the designer clicked something.
 */
describe("targetOptions", () => {
  const at = (x: number, y: number, w: number, h: number) => ({
    bbox: { x, y, w, h },
    relBbox: { x, y, w, h },
    rotation: 0,
    aspect: w / (h || 1),
    aspectBucket: "wide" as const,
  });

  const tree = node({
    id: "1:1",
    name: "Page",
    geometry: at(0, 0, 1366, 900),
    children: [
      node({
        id: "1:2",
        name: "Header",
        geometry: at(0, 0, 1366, 400),
        children: [node({ id: "1:3", name: "Inner", geometry: at(40, 120, 200, 80) })],
      }),
    ],
  });

  it("lists the ancestors nearest first", () => {
    expect(targetOptions(tree, "1:3").map((t) => t.name)).toEqual(["Header", "Page"]);
  });

  it("returns nothing for a node that is not in this frame", () => {
    expect(targetOptions(tree, "9:99")).toEqual([]);
  });
});

describe("assetRef", () => {
  it("is the token the compiler and the agent both speak", () => {
    expect(assetRef("top_header")).toBe("asset.texture.top_header");
  });
});
