/**
 * Slot accounting and batching — the two halves of the panel's arithmetic.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { batchesToReach, buildBatches, groupQueue, isSafe, queueGroup, safeSlotCount } from "../src/health/batch.js";
import { computeCoverage, percent } from "../src/health/coverage.js";
import { enumerateSlots, invalidateSlots } from "../src/health/slots.js";
import type { Finding, Proposal } from "../src/health/types.js";
import { lint } from "../src/rules/index.js";
import {
  bound,
  boundFill,
  context,
  document,
  loose,
  looseEffect,
  looseFill,
  looseText,
  node,
  withDepths,
} from "./health-fixtures.js";

describe("enumerateSlots", () => {
  it("counts one slot per bindable property", () => {
    const n = node({
      layoutMode: "horizontal",
      fill: looseFill("#ffffff"),
      stroke: { raw: "#000000", weight: 1, unbound: true },
      radius: loose(8),
      gap: loose(10),
      padding: { top: loose(16), left: loose(24) },
      effects: [looseEffect(), looseEffect("INNER_SHADOW")],
    });
    // fill, stroke, radius, gap, 2 paddings, 2 effects
    expect(enumerateSlots(n)).toHaveLength(8);
  });

  it("counts a zero radius but not zero spacing", () => {
    const zeroRadius = node({ radius: { value: 0, unbound: false } });
    expect(enumerateSlots(zeroRadius)).toHaveLength(1);
    expect(enumerateSlots(zeroRadius)[0]!.bound).toBe(false);

    const zeroSpacing = node({ layoutMode: "horizontal", gap: loose(0), padding: { top: loose(0) } });
    expect(enumerateSlots(zeroSpacing)).toHaveLength(0);
  });

  it("treats a radius with a variable as bound even at zero", () => {
    const n = node({ radius: bound(0, "radius.none") });
    expect(enumerateSlots(n)[0]!.bound).toBe(true);
  });

  it("reads text and fill bound-ness from the IR's own flags", () => {
    const n = node({ type: "TEXT", fill: boundFill(), text: looseText() });
    const slots = enumerateSlots(n);
    expect(slots.find((s) => s.kind === "fill")!.bound).toBe(true);
    expect(slots.find((s) => s.kind === "text")!.bound).toBe(false);
  });
});

describe("the memoized walk", () => {
  it("must be invalidated when a subtree is patched in place", () => {
    // The exact shape of an incremental re-lint: the root object stays the same
    // and a child is replaced. Without invalidation the memo returns the slots
    // from before the edit, so the score cannot move — a designer binds a
    // variable, the panel re-lints, and the percentage sits there unchanged.
    const child = node({ fill: looseFill("#ffffff") });
    const root = withDepths(node({ children: [child] }));

    expect(computeCoverage(root).loose).toBe(1);

    root.children[0] = node({ fill: boundFill() });
    expect(computeCoverage(root).loose, "stale memo").toBe(1);

    invalidateSlots(root);
    expect(computeCoverage(root).loose).toBe(0);
    expect(computeCoverage(root).bound).toBe(1);
  });

  it("still shares one walk across the rules of a single lint", () => {
    const root = withDepths(node({ children: [node({ fill: looseFill("#ffffff") })] }));
    expect(enumerateSlots(root)).toBe(enumerateSlots(root));
  });
});

describe("computeCoverage", () => {
  it("is bound over total, to one decimal", () => {
    expect(percent(1339, 2485)).toBe(53.9);
  });

  it("breaks the tally down by kind", () => {
    const root = withDepths(
      node({
        children: [
          node({ fill: looseFill("#ffffff") }),
          node({ fill: boundFill() }),
          node({ radius: loose(8) }),
        ],
      }),
    );
    const coverage = computeCoverage(root, 1);
    expect(coverage).toMatchObject({ total: 3, bound: 1, loose: 2 });
    expect(coverage.byKind.fill).toEqual({ total: 2, bound: 1, loose: 1 });
    expect(coverage.byKind.radius).toEqual({ total: 1, bound: 0, loose: 1 });
    expect(coverage.projectedPercent).toBe(percent(2, 3));
  });

  it("keeps the projected score honest — bound plus one-click over total", () => {
    const root = withDepths(node({ children: [node({ fill: looseFill("#ffffff") })] }));
    const coverage = computeCoverage(root, 1);
    expect(coverage.percent).toBe(0);
    expect(coverage.oneClickPercent).toBe(100);
    expect(coverage.projectedPercent).toBe(100);
  });
});

describe("buildBatches", () => {
  const finding = (over: Partial<Finding> = {}): Finding => ({
    ruleId: "unbound-fill",
    severity: "fixable",
    nodeId: "n1",
    nodeName: "Layer",
    nodeType: "FRAME",
    scope: "fill",
    propPath: "fill",
    currentValue: "#ffffff",
    message: "m",
    occupiesSlot: true,
    ...over,
  });

  const exact = (tokenRef: string): Proposal => ({
    kind: "exact",
    tokenRef,
    confidence: 1,
    candidates: [{ tokenRef, distance: 0, value: "#ffffff", bindable: true }],
    target: { type: "paint", slot: "fill" },
    bindable: true,
  });

  const rule = { id: "unbound-fill", code: "F1" };

  it("groups by rule, slot, value and proposed token", () => {
    const batches = buildBatches(
      [
        { finding: finding(), proposal: exact("color.core_neu_00"), rule },
        { finding: finding({ nodeId: "n2" }), proposal: exact("color.core_neu_00"), rule },
        { finding: finding({ currentValue: "#000000" }), proposal: exact("color.core_neu_950"), rule },
      ],
      100,
    );
    expect(batches).toHaveLength(2);
    expect(batches[0]!.count).toBe(2);
    expect(batches[0]!.coverageGain).toBe(2);
    expect(batches[0]!.items.map((i) => i.nodeId)).toEqual(["n1", "n2"]);
  });

  it("keeps the same value in different slots apart", () => {
    // Without the slot in the key, a 16px gap and a 16px padding become one row
    // labelled "16" — and the row stops meaning anything.
    const batches = buildBatches(
      [
        { finding: finding({ scope: "gap", currentValue: "16", propPath: "layout.gap" }), proposal: exact("space.4"), rule },
        {
          finding: finding({ scope: "padding", currentValue: "16", propPath: "layout.padding.top" }),
          proposal: exact("space.4"),
          rule,
        },
      ],
      100,
    );
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.slotLabel).sort()).toEqual(["gap", "padding"]);
  });

  it("ranks by count, biggest lever first", () => {
    const inputs = [
      ...Array.from({ length: 3 }, (_, i) => ({
        finding: finding({ nodeId: `a${i}`, currentValue: "#aaaaaa" }),
        proposal: exact("color.a"),
        rule,
      })),
      ...Array.from({ length: 7 }, (_, i) => ({
        finding: finding({ nodeId: `b${i}`, currentValue: "#bbbbbb" }),
        proposal: exact("color.b"),
        rule,
      })),
    ];
    expect(buildBatches(inputs, 100).map((b) => b.count)).toEqual([7, 3]);
  });

  it("counts distinct raw values, which is the surface-recipe count", () => {
    const batches = buildBatches(
      [
        { finding: finding({ currentValue: "linear-gradient", rawValue: "GRADIENT_LINEAR(a)" }), proposal: null, rule },
        { finding: finding({ currentValue: "linear-gradient", rawValue: "GRADIENT_LINEAR(b)" }), proposal: null, rule },
        { finding: finding({ currentValue: "linear-gradient", rawValue: "GRADIENT_LINEAR(a)" }), proposal: null, rule },
      ],
      100,
    );
    expect(batches[0]!.count).toBe(3);
    expect(batches[0]!.distinctRawValues).toBe(2);
  });

  it("excludes findings that occupy no slot", () => {
    const batches = buildBatches(
      [{ finding: finding({ occupiesSlot: false }), proposal: exact("color.core_neu_00"), rule }],
      100,
    );
    expect(batches).toHaveLength(0);
  });

  it("is deterministic", () => {
    const inputs = [
      { finding: finding({ currentValue: "#111111" }), proposal: exact("color.x"), rule },
      { finding: finding({ currentValue: "#222222" }), proposal: exact("color.y"), rule },
    ];
    const first = buildBatches(inputs, 100).map((b) => b.id);
    for (let i = 0; i < 5; i++) {
      expect(buildBatches(inputs, 100).map((b) => b.id)).toEqual(first);
    }
  });

  it("splits the queue by what the designer has to do", () => {
    const batches = buildBatches(
      [
        { finding: finding({ currentValue: "#ffffff" }), proposal: exact("color.x"), rule },
        {
          finding: finding({ currentValue: "#ff4b32", nodeId: "n:near" }),
          proposal: {
            kind: "near",
            tokenRef: "color.y",
            confidence: 0.7,
            candidates: [{ tokenRef: "color.y", distance: 4, value: "#ff4b32", bindable: true }],
            target: { type: "paint", slot: "fill" },
            bindable: true,
          },
          rule,
        },
      ],
      10,
    );
    expect(queueGroup(batches.find((b) => b.currentValue === "#ffffff")!)).toBe("bind");
    expect(queueGroup(batches.find((b) => b.currentValue === "#ff4b32")!)).toBe("review");
    expect(groupQueue(batches).bind).toHaveLength(1);
    expect(groupQueue(batches).review).toHaveLength(1);
  });

  it("puts a near match with no bindable candidate in create, not review", () => {
    const batches = buildBatches(
      [
        {
          finding: finding({ currentValue: "#000000" }),
          proposal: {
            kind: "near",
            tokenRef: "color.core_neu_950",
            confidence: 0.4,
            candidates: [
              { tokenRef: "color.core_neu_950", distance: 9, value: "#0a0a0a", bindable: false },
            ],
            target: { type: "paint", slot: "fill" },
            bindable: false,
          },
          rule,
        },
      ],
      10,
    );
    expect(queueGroup(batches[0]!)).toBe("create");
  });
});

describe("isSafe", () => {
  const base = {
    tokenRef: "color.x",
    confidence: 1,
    candidates: [],
    target: { type: "paint", slot: "fill" } as const,
  };

  it("requires exact AND bindable", () => {
    expect(isSafe({ ...base, kind: "exact", bindable: true })).toBe(true);
    expect(isSafe({ ...base, kind: "exact", bindable: false })).toBe(false);
    expect(isSafe({ ...base, kind: "near", bindable: true })).toBe(false);
    expect(isSafe({ kind: "none", reason: "r", hint: "h" })).toBe(false);
    expect(isSafe(null)).toBe(false);
    expect(isSafe({ kind: "round", roundedTo: 13, target: { type: "round", field: "paddingTop" } })).toBe(
      false,
    );
  });
});

describe("one definition of bound", () => {
  it("is the only tally in the package", () => {
    // The Export tab used to carry its own `countBindings`, inherited from the
    // extractor, which skipped zero radii and scored zero gaps as BOUND. The two
    // tabs then quoted different coverage for the same page and both sounded
    // authoritative. It is deleted; this asserts it stays deleted.
    const traverse = readFileSync("src/traverse.ts", "utf8");
    expect(traverse).not.toMatch(/countBindings/);

    const exportSrc = readFileSync("src/export.ts", "utf8");
    expect(exportSrc).toMatch(/coverageFromSlots/);
  });

  it("counts a zero radius and a zero gap the way the panel explains", () => {
    // The two cases the old tally got wrong, pinned explicitly.
    const zeroRadius = withDepths(node({ radius: { value: 0, unbound: false } }));
    expect(computeCoverage(zeroRadius)).toMatchObject({ total: 1, bound: 0, loose: 1 });

    const zeroGap = withDepths(node({ layoutMode: "horizontal", gap: loose(0) }));
    expect(computeCoverage(zeroGap)).toMatchObject({ total: 0, bound: 0, loose: 0 });
  });
});

describe("the score and the queue agree", () => {
  it("one-click gain equals the safe batches' slots", () => {
    const root = withDepths(
      node({
        layoutMode: "vertical",
        children: [
          node({ fill: looseFill("#ffffff") }),
          node({ fill: looseFill("#ffffff") }),
          node({ fill: looseFill("GRADIENT_LINEAR(#fff 0%, #000 100%)") }),
          node({ fill: boundFill() }),
        ],
      }),
    );
    const report = lint(document(root), context());
    expect(report.coverage.oneClickAway).toBe(safeSlotCount(report.batches));
    expect(report.coverage.oneClickAway).toBe(2);
  });
});

describe("batchesToReach", () => {
  it("finds the smallest prefix covering the target share", () => {
    const batches = [10, 5, 3, 2].map((count, i) => ({ count, id: `b${i}` }));
    expect(batchesToReach(batches as never, 20, 90)).toBe(3);
    expect(batchesToReach(batches as never, 20, 50)).toBe(1);
  });
});
