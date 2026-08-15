import { describe, expect, it } from "vitest";
import { sizingReady, sizingReport } from "../src/health/sizing.js";
import { document, looseText, node, withDepths } from "./health-fixtures.js";

describe("sizingReport", () => {
  it("counts hug / fill / fixed axes", () => {
    const root = withDepths(
      node({
        layoutMode: "vertical",
        children: [
          node({ text: looseText({ autoResize: "HEIGHT" }) }),
          node({ text: looseText({ autoResize: "NONE" }) }),
        ],
      }),
    );
    const report = sizingReport(document(root));
    expect(report.axes.total).toBe(6);
    expect(report.textTotal).toBe(2);
    expect(report.huggingText).toBe(1);
    expect(report.pinnedText).toHaveLength(1);
    expect(report.pinnedText[0]!.autoResize).toBe("NONE");
    expect(sizingReady(report)).toBe(false);
  });

  it("treats HEIGHT and WIDTH_AND_HEIGHT as ready for bindings", () => {
    const root = withDepths(
      node({
        children: [
          node({ text: looseText({ autoResize: "HEIGHT" }) }),
          node({ text: looseText({ autoResize: "WIDTH_AND_HEIGHT" }) }),
        ],
      }),
    );
    const report = sizingReport(document(root));
    expect(report.pinnedText).toHaveLength(0);
    expect(report.huggingText).toBe(2);
    expect(sizingReady(report)).toBe(true);
  });

  it("does not treat truncate as pinned — that is a clamp", () => {
    const root = withDepths(node({ text: looseText({ autoResize: "TRUNCATE" }) }));
    expect(sizingReport(document(root)).pinnedText).toHaveLength(0);
  });
});
