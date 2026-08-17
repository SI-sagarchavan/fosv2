/**
 * The gate's arithmetic. These rules decide whether a surface may be published,
 * so they are tested against the domain's own `ConformOutcome` — no compiler,
 * no database, nothing to mock.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_THRESHOLDS,
  evaluate,
  scoreOf,
  summarise,
  type ConformOutcome,
  type Thresholds,
} from "../src/modules/fidelity/domain/gate.js";

function outcome(over: {
  errors?: number;
  warnings?: number;
  coverage?: Partial<ConformOutcome["coverage"]>;
}): ConformOutcome {
  const finding = (severity: "error" | "warning", i: number) => ({
    code: severity === "error" ? "C1" : "C3",
    severity,
    message: `finding ${i}`,
    nodeId: `n${i}`,
  });

  return {
    ok: (over.errors ?? 0) === 0,
    errors: Array.from({ length: over.errors ?? 0 }, (_, i) => finding("error", i)),
    warnings: Array.from({ length: over.warnings ?? 0 }, (_, i) => finding("warning", i)),
    coverage: { paints: 10, direct: 10, absorbed: 0, repeated: 0, missing: 0, ...over.coverage },
    geometry: { compared: 0, skipped: 0, exempt: 0, worstDelta: 0, totalDelta: 0 },
    nodeCount: 12,
    waived: 0,
  };
}

describe("scoreOf", () => {
  it("counts direct, absorbed and repeated as accounted for", () => {
    expect(
      scoreOf(outcome({ coverage: { paints: 10, direct: 4, absorbed: 3, repeated: 3 } })),
    ).toBe(1);
  });

  it("drops as nodes go missing", () => {
    expect(
      scoreOf(outcome({ coverage: { paints: 10, direct: 7, missing: 3 } })),
    ).toBeCloseTo(0.7);
  });

  it("calls a frame with nothing to paint fully covered rather than dividing by zero", () => {
    expect(scoreOf(outcome({ coverage: { paints: 0, direct: 0 } }))).toBe(1);
  });

  it("clamps above 1 if the checks ever double-count", () => {
    expect(scoreOf(outcome({ coverage: { paints: 2, direct: 2, absorbed: 2 } }))).toBe(1);
  });
});

describe("evaluate", () => {
  it("passes a clean outcome", () => {
    expect(evaluate(outcome({}), DEFAULT_THRESHOLDS)).toBe(true);
  });

  it("fails on any error by default", () => {
    expect(evaluate(outcome({ errors: 1 }), DEFAULT_THRESHOLDS)).toBe(false);
  });

  it("ignores warnings by default", () => {
    expect(evaluate(outcome({ warnings: 9 }), DEFAULT_THRESHOLDS)).toBe(true);
  });

  it("bites on warnings once maxWarnings is set", () => {
    const strict: Thresholds = { ...DEFAULT_THRESHOLDS, maxWarnings: 2 };
    expect(evaluate(outcome({ warnings: 2 }), strict)).toBe(true);
    expect(evaluate(outcome({ warnings: 3 }), strict)).toBe(false);
  });

  it("fails when coverage falls under the floor", () => {
    const missing = outcome({ coverage: { paints: 10, direct: 9, missing: 1 } });
    expect(evaluate(missing, DEFAULT_THRESHOLDS)).toBe(false);
    expect(evaluate(missing, { ...DEFAULT_THRESHOLDS, minCoverage: 0.9 })).toBe(true);
  });
});

describe("summarise", () => {
  it("rolls findings up by code and severity, commonest first", () => {
    const summary = summarise(outcome({ errors: 3, warnings: 1 }));
    expect(summary).toEqual([
      { code: "C1", severity: "error", count: 3, sample: "finding 0" },
      { code: "C3", severity: "warning", count: 1, sample: "finding 0" },
    ]);
  });

  it("is empty for a clean outcome", () => {
    expect(summarise(outcome({}))).toEqual([]);
  });
});
