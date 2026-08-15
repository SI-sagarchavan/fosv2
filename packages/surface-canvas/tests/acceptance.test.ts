/**
 * The acceptance run: the whole engine over a page shaped like the real one.
 *
 * See southern-brave-shape.ts for what this fixture is and — importantly — what
 * it is not. It proves the engine turns the recorded distribution into the
 * documented report. Only running the plugin against the actual file proves the
 * file still has that distribution.
 */
import { describe, expect, it } from "vitest";
import { lint } from "../src/rules/index.js";
import { enumerateSlots } from "../src/health/slots.js";
import { context } from "./health-fixtures.js";
import { CLUSTERS, SHAPE, southernBraveShape } from "./southern-brave-shape.js";

const ir = southernBraveShape();
const report = lint(ir, context());

describe("the reference page", () => {
  it("has the recorded shape", () => {
    expect(enumerateSlots(ir.root)).toHaveLength(SHAPE.totalSlots);
    expect(countNodes()).toBe(SHAPE.nodeCount);
  });

  it("reads 53.9% coverage from 1,339 bound of 2,485", () => {
    expect(report.coverage).toMatchObject({
      total: SHAPE.totalSlots,
      bound: SHAPE.boundSlots,
      loose: SHAPE.looseSlots,
      percent: SHAPE.coveragePercent,
    });
  });

  it("counts every loose slot exactly once as a fixable finding", () => {
    // The invariant the panel depends on: the score's denominator and the fix
    // queue's contents are the same set. If these ever diverge, the bar is
    // promising a gain the queue cannot deliver.
    const inBatches = report.batches.reduce((sum, batch) => sum + batch.count, 0);
    expect(inBatches).toBe(SHAPE.looseSlots);
  });
});

describe("blockers", () => {
  it("fires all three", () => {
    expect(report.blockers.map((b) => b.ruleId).sort()).toEqual([
      "groups-instead-of-frames",
      "no-mobile-frames",
      "root-not-autolayout",
    ]);
  });

  it("B1 names the root's layout mode", () => {
    const b1 = report.blockers.find((b) => b.ruleId === "root-not-autolayout")!;
    expect(b1.currentValue).toBe("none");
    expect(b1.nodeId).toBe("1:4366");
    expect(b1.message).toContain("Not a column");
  });

  it("B2 counts 79 groups holding 516 layers", () => {
    const b2 = report.blockers.find((b) => b.ruleId === "groups-instead-of-frames")!;
    expect(b2.detail).toMatchObject({ groups: SHAPE.groups, layers: SHAPE.groupedLayers });
    expect(b2.message).toContain("79 groups · 516 layers");
  });

  it("offers convert-groups only — wrapping a frame as a column is never safe", () => {
    expect(report.actions.map((a) => a.id)).toEqual(["convert-groups"]);
  });

  it("B3 finds no mobile frame and reports the widths that are there", () => {
    const b3 = report.blockers.find((b) => b.ruleId === "no-mobile-frames")!;
    expect(b3.detail?.widthsPresent).toBe("1366, 1368");
    expect(b3.detail?.searchedRange).toBe("320-480");
  });
});

describe("the fix queue", () => {
  it("produces the seven expected batches, in order, at the expected counts", () => {
    const top = report.batches.slice(0, CLUSTERS.length);
    expect(top.map((b) => [b.slotLabel, b.currentValue, b.count])).toEqual(
      CLUSTERS.map((c) => [c.kind, c.value, c.count]),
    );
  });

  it("marks exactly the four exact batches safe, worth +12.9%", () => {
    const safe = report.batches.filter((b) => b.safe);
    expect(safe.reduce((sum, b) => sum + b.count, 0)).toBe(SHAPE.safeSlots);
    expect(report.coverage.oneClickAway).toBe(SHAPE.safeSlots);
    expect(report.coverage.oneClickPercent).toBe(SHAPE.oneClickPercent);
  });

  it("proposes the expected token for each exact batch", () => {
    for (const cluster of CLUSTERS) {
      if (!("token" in cluster)) continue;
      const batch = report.batches.find(
        (b) => b.slotLabel === cluster.kind && b.currentValue === cluster.value,
      )!;
      expect(batch.proposal).toMatchObject({ kind: "exact", tokenRef: cluster.token, bindable: true });
      expect(batch.safe).toBe(true);
    }
  });

  it("gives gradients no proposal and counts the surface recipes needed", () => {
    const batch = report.batches[0]!;
    expect(batch.currentValue).toBe("linear-gradient");
    expect(batch.proposal).toMatchObject({ kind: "none" });
    expect(batch.safe).toBe(false);
    expect(batch.distinctRawValues).toBe(4);
    expect((batch.proposal as { reason: string }).reason).toContain("surface recipe");
  });

  it("offers #ff4b32 two near candidates and refuses to bulk-apply them", () => {
    const batch = report.batches.find((b) => b.currentValue === "#ff4b32")!;
    expect(batch.proposal).toMatchObject({ kind: "near" });
    const proposal = batch.proposal as { candidates: Array<{ tokenRef: string }> };
    expect(proposal.candidates.map((c) => c.tokenRef)).toEqual([
      "color.core_prim_400",
      "color.core_prim_500",
    ]);
    expect(batch.safe).toBe(false);
  });

  it("offers #000000 near candidates from the neutral ramp only", () => {
    const batch = report.batches.find((b) => b.currentValue === "#000000")!;
    expect(batch.proposal).toMatchObject({ kind: "near" });
    const proposal = batch.proposal as { candidates: Array<{ tokenRef: string }> };
    // Two, not the one the build spec predicted. Both are legitimate blacks and
    // no single (metric, threshold) pair yields 1 here and 2 for #ff4b32 —
    // see README, "The ΔE threshold".
    expect(proposal.candidates.map((c) => c.tokenRef)).toEqual([
      "color.core_neu_950",
      "color.core_neu_900",
    ]);
    expect(batch.safe).toBe(false);
  });

  it("offers a token for subpixel spacing and radius, never a round step", () => {
    const subpixels = report.batches.filter((b) =>
      (SHAPE.subpixelValues as readonly number[]).includes(Number.parseFloat(b.currentValue)),
    );
    expect(subpixels.length).toBeGreaterThan(0);
    for (const batch of subpixels) {
      expect(batch.ruleId === "unbound-spacing" || batch.ruleId === "unbound-radius").toBe(true);
      expect(batch.proposal?.kind).not.toBe("round");
    }
  });

  it("reports how many batches cover 90% of the loose values", () => {
    expect(report.batchesFor90Percent).toBeGreaterThan(0);
    const covered = report.batches
      .slice(0, report.batchesFor90Percent)
      .reduce((sum, b) => sum + b.count, 0);
    expect(covered / report.coverage.loose).toBeGreaterThanOrEqual(0.9);
  });
});

describe("W1", () => {
  it("reports a default-name percentage that excludes vectors", () => {
    const w1 = report.warns.find((w) => w.ruleId === "default-layer-names")!;
    const percent = w1.detail?.percent as number;
    // The real file measures ~45%; the fixture is built to the same order of
    // magnitude rather than to the exact figure.
    expect(percent).toBeGreaterThan(40);
    expect(percent).toBeLessThan(55);
    expect(w1.detail?.excludedVectors).toBeGreaterThan(600);
  });
});

describe("performance", () => {
  it("lints 1,596 nodes well inside the 3s budget", () => {
    const started = Date.now();
    lint(ir, context());
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

function countNodes(): number {
  let count = 0;
  const stack = [ir.root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    count++;
    for (const child of node.children) stack.push(child);
  }
  return count;
}
