/**
 * The panel reducer. Pure, so the message handling is testable without a DOM.
 */
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../src/ui/state.js";
import type { AppliedPayload, PluginMessage } from "../src/protocol.js";
import { PANEL_SIZES } from "../src/protocol.js";
import { lint } from "../src/rules/index.js";
import { reconciliationReport } from "../src/health/reconcile-report.js";
import { context, document, looseFill, node, themeSnapshot, withDepths } from "./health-fixtures.js";

const snapshot = themeSnapshot();
const report = lint(
  document(withDepths(node({ layoutMode: "vertical", children: [node({ fill: looseFill("#ffffff") })] }))),
  context({ theme: snapshot }),
);

const reportMessage: PluginMessage = {
  type: "report",
  report,
  reconciliation: reconciliationReport(snapshot),
  activity: [],
  scope: "full",
  nodeCount: 2,
};

const applied: AppliedPayload = {
  batchId: report.batches[0]!.id,
  label: "fill #ffffff",
  tokenRef: "color.core_neu_00",
  applied: 1,
  failed: 0,
  failures: [],
  undoable: true,
  user: { id: "u1", name: "Priya Shah", color: "#e10a15" },
};

describe("reduce", () => {
  it("boots with the file, the themes and the stored panel size", () => {
    const next = reduce(initialState, {
      type: "boot",
      payload: {
        fileName: "Southern Brave",
        pageName: "Home",
        themes: [{ id: "t1", name: "Southern Brave", slug: "southern-brave", source: "f.json" }],
        themeId: "t1",
        panelState: "collapsed",
        user: { id: "u1", name: "Priya Shah", color: "#e10a15" },
      },
    });
    expect(next.booted).toBe(true);
    expect(next.user?.name).toBe("Priya Shah");
    expect(next.panelState).toBe("collapsed");
    expect(next.themes).toHaveLength(1);
  });

  it("stores a report and clears any error", () => {
    const errored = reduce(initialState, { type: "error", message: "boom" });
    expect(errored.error).toBe("boom");
    const next = reduce(errored, reportMessage);
    expect(next.error).toBeNull();
    expect(next.report?.coverage.loose).toBe(1);
    expect(next.nodeCount).toBe(2);
    expect(next.activity).toEqual([]);
  });

  it("keeps another designer's activity without turning it into Undo", () => {
    const withActivity = reduce(initialState, {
      ...reportMessage,
      activity: [
        {
          id: "a1",
          actor: { id: "u2", name: "Amit Rao", color: "#2939a3" },
          kind: "bind",
          label: "fill #ffffff",
          tokenRef: "color.core_neu_00",
          applied: 110,
          at: 1,
        },
      ],
    });
    expect(withActivity.activity).toHaveLength(1);
    expect(withActivity.applied).toBeNull();
  });

  it("keeps the undo notice across a later report", () => {
    // The affordance stays until dismissed or superseded. A re-lint arrives
    // milliseconds after a fix; losing the notice there would make Undo a race.
    const withNotice = reduce(reduce(initialState, reportMessage), {
      type: "applied",
      payload: applied,
    });
    const afterRelint = reduce(withNotice, { ...reportMessage, scope: "incremental" });
    expect(afterRelint.applied).toEqual(applied);
  });

  it("supersedes the notice when a second fix lands", () => {
    const first = reduce(initialState, { type: "applied", payload: applied });
    const second = reduce(first, {
      type: "applied",
      payload: { ...applied, tokenRef: "space.4", applied: 78 },
    });
    expect(second.applied?.tokenRef).toBe("space.4");
    expect(second.applied?.applied).toBe(78);
  });

  it("stops being busy once a report lands, even with no status behind it", () => {
    // The regression this guards: `busy` starts true and gates every button, and
    // it used to be reachable only through a transient `status` message. A run
    // that finished before the iframe attached its listener left the panel on
    // "Starting…" with a disabled Export tab and a complete report on screen.
    expect(initialState.busy).toBe(true);
    const next = reduce(initialState, reportMessage);
    expect(next.busy).toBe(false);
    expect(next.status).toBe("");
    expect(next.report).not.toBeNull();
  });

  it("lets a status that follows a report put it back to work", () => {
    // An incremental re-lint during a bulk fix posts report-then-status in the
    // same tick; the status wins, which is what keeps buttons disabled mid-apply.
    const reported = reduce(initialState, reportMessage);
    const working = reduce(reported, { type: "status", message: "Linting…", busy: true });
    expect(working.busy).toBe(true);
  });

  it("takes the panel state from the sandbox, never from a click", () => {
    // The sandbox posts this only after the window has actually resized, so a
    // resize that fails leaves the layout matching the window that exists.
    const collapsed = reduce(initialState, { type: "panel-state", state: "collapsed" });
    expect(collapsed.panelState).toBe("collapsed");
    expect(reduce(collapsed, { type: "panel-state", state: "expanded" }).panelState).toBe(
      "expanded",
    );
  });

  it("names the frame being checked, not just the page", () => {
    const next = reduce(initialState, reportMessage);
    expect(next.report?.rootName).toBe(report.rootName);
    expect(next.report?.rootName.length).toBeGreaterThan(0);
  });

  it("tracks the heatmap and the selection", () => {
    const on = reduce(initialState, { type: "heatmap", on: true, nodes: 1400 });
    expect(on).toMatchObject({ heatmapOn: true, heatmapNodes: 1400 });
    const off = reduce(on, { type: "heatmap", on: false, nodes: 0 });
    expect(off.heatmapOn).toBe(false);

    const selected = reduce(initialState, {
      type: "selection",
      count: 1,
      name: "Hero",
      id: "1:99",
    });
    expect(selected).toMatchObject({ selectionCount: 1, selectionName: "Hero", selectionId: "1:99" });
  });

  it("carries no selection id for something that isn't a container", () => {
    // The re-target offer keys off this: a selected text layer is not a page to
    // check, so the header must not offer to check it.
    const selected = reduce(initialState, {
      type: "selection",
      count: 1,
      name: "Headline",
      id: null,
    });
    expect(selected.selectionId).toBeNull();
  });

  it("ignores an unknown message instead of wiping state", () => {
    const next = reduce(initialState, { type: "boot", payload: {
      fileName: "F",
      pageName: "P",
      themes: [],
      themeId: "t",
      panelState: "expanded",
      user: { id: null, name: "Anonymous", color: "#6b6b6b" },
    }});
    expect(reduce(next, { type: "not-a-message" } as never)).toBe(next);
  });

  it("clears busy on an error so the panel never wedges", () => {
    const busy = reduce(initialState, { type: "status", message: "Walking…", busy: true });
    expect(busy.busy).toBe(true);
    expect(reduce(busy, { type: "error", message: "nope" }).busy).toBe(false);
  });

  it("keeps the export payload until the next run", () => {
    const done = reduce(initialState, {
      type: "export-done",
      jsonName: "a.ir.json",
      json: "{}",
      screenshots: [],
      summary: { nodeCount: 2 },
      publish: { kind: "sent", origin: "http://localhost:3000" },
    });
    expect(done.exportResult?.jsonName).toBe("a.ir.json");
    expect(done.exportProgress).toBe("");
    expect(done.exportPublish).toEqual({ kind: "sent", origin: "http://localhost:3000" });
  });
});

describe("panel sizes", () => {
  it("matches the two states the spec calls for", () => {
    expect(PANEL_SIZES.expanded).toEqual({ width: 448, height: 720 });
    expect(PANEL_SIZES.collapsed).toEqual({ width: 280, height: 44 });
  });
});
