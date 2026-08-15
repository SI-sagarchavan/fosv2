import { describe, expect, it } from "vitest";
import { reconciliationReport } from "../src/health/reconcile-report.js";
import { themeSnapshot } from "./health-fixtures.js";

describe("reconciliationReport", () => {
  it("counts every token in the theme", () => {
    const report = reconciliationReport(themeSnapshot());
    expect(report.total).toBeGreaterThan(200);
    expect(report.bindable).toBe(report.total);
    expect(report.missing).toHaveLength(0);
    expect(report.mismatched).toHaveLength(0);
  });

  it("lists tokens with no Figma variable", () => {
    const snapshot = themeSnapshot({ bindable: (ref) => !ref.startsWith("space.") });
    const report = reconciliationReport(snapshot);
    expect(report.missing.length).toBe(snapshot.spaces.length);
    expect(report.missing.every((token) => token.category === "space")).toBe(true);
    const space = report.byCategory.find((c) => c.category === "space")!;
    expect(space.bindable).toBe(0);
    expect(space.missing).toBe(space.total);
  });

  it("separates a value mismatch from a missing variable", () => {
    // These are the dangerous ones — the variable exists, so a naive check would
    // call the batch safe.
    const report = reconciliationReport(
      themeSnapshot({ mismatched: new Set(["space.4", "color.core_neu_00"]) }),
    );
    expect(report.mismatched.map((t) => t.ref).sort()).toEqual(["color.core_neu_00", "space.4"]);
    expect(report.missing).toHaveLength(0);
    expect(report.bindable).toBe(report.total - 2);
    expect(report.mismatched[0]!.figmaValue).toBeTruthy();
  });

  it("passes orphan variables through", () => {
    const report = reconciliationReport(
      themeSnapshot({
        orphans: [
          { medium: "variable", figmaName: "legacy/brand-red", collection: "Brand", resolvedType: "COLOR" },
        ],
      }),
    );
    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0]!.figmaName).toBe("legacy/brand-red");
  });

  it("reports the no-local-collections case, which is not the same as no tokens", () => {
    const report = reconciliationReport(
      themeSnapshot({ bindable: () => false, localCollections: 0 }),
    );
    expect(report.localCollections).toBe(0);
    expect(report.libraryCollections).toBe(0);
    expect(report.bindable).toBe(0);
  });

  it("counts tokens that will be imported from a library on first use", () => {
    // The shape of a design-system consumer: no local collections at all, and
    // every binding waiting behind an import.
    const snapshot = themeSnapshot({ localCollections: 0, libraryCollections: 2 });
    for (const entry of snapshot.colors) {
      if (entry.binding) entry.binding = { ...entry.binding, medium: "libraryVariable", key: "k" };
    }
    const report = reconciliationReport(snapshot);
    expect(report.libraryCollections).toBe(2);
    expect(report.fromLibrary).toBe(snapshot.colors.length);
    // Still bindable — a library variable binds like any other, it just imports first.
    expect(report.bindable).toBe(report.total);
  });

  it("orders categories by size so the report reads biggest-first", () => {
    const report = reconciliationReport(themeSnapshot());
    const totals = report.byCategory.map((c) => c.total);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
  });
});
