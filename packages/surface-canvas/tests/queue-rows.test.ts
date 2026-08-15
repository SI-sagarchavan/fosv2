/**
 * The panel's one layout promise, as a test: no action ever appends a block.
 *
 * Skip, bind and undo all resolve where they were taken. That is not a styling
 * detail — a queue that grows a banner every time you press a button moves the
 * row you were about to press next, and on a 390px panel that is the difference
 * between working through it and losing your place every few seconds.
 */
import { describe, expect, it } from "vitest";
import { lint } from "../src/rules/index.js";
import { reconciliationReport } from "../src/health/reconcile-report.js";
import { isFixProposal } from "../src/health/types.js";
import type { LintReport } from "../src/health/types.js";
import type { AppliedPayload, PluginMessage } from "../src/protocol.js";
import { initialState, reduce } from "../src/ui/state.js";
import type { PanelInput, StudioState } from "../src/ui/state.js";
import {
  bindAction,
  isActionable,
  pickedCandidate,
  queueRows,
  targetLine,
  tileGlyph,
} from "../src/ui/rows.js";
import {
  context,
  document,
  loose,
  looseFill,
  node,
  themeSnapshot,
  withDepths,
} from "./health-fixtures.js";

const snapshot = themeSnapshot();

const report = lint(
  document(
    withDepths(
      node({
        layoutMode: "vertical",
        children: [
          node({ fill: looseFill("#ffffff") }),
          node({ fill: looseFill("#ffffff") }),
          node({ fill: looseFill("#ffffff") }),
          node({ fill: looseFill("#1a237e") }),
          node({ fill: looseFill("#1a237e") }),
          node({ radius: loose(14) }),
        ],
      }),
    ),
  ),
  context({ theme: snapshot }),
);

const user = { id: "u1", name: "Sagar Chavan", color: "#ffc700" };

function reportMessage(
  scope: "full" | "incremental",
  override: LintReport = report,
): PluginMessage {
  return {
    type: "report",
    report: override,
    reconciliation: reconciliationReport(snapshot),
    activity: [],
    scope,
    nodeCount: 7,
  };
}

/** The report minus one batch — what an incremental re-lint after a bind posts. */
function without(batchId: string): LintReport {
  return { ...report, batches: report.batches.filter((batch) => batch.id !== batchId) };
}

function appliedFor(batchId: string, tokenRef: string, count: number): AppliedPayload {
  return {
    batchId,
    label: "fill #ffffff",
    tokenRef,
    applied: count,
    failed: 0,
    failures: [],
    undoable: true,
    user,
  };
}

function run(...inputs: PanelInput[]): StudioState {
  return inputs.reduce(reduce, initialState);
}

const booted = run(reportMessage("full"));

describe("the fixture report", () => {
  it("has enough batches to have an order worth preserving", () => {
    expect(report.batches.length).toBeGreaterThanOrEqual(3);
  });
});

describe("queueRows", () => {
  it("draws one row per batch, in the report's order", () => {
    const rows = queueRows(booted);
    expect(rows.map((row) => row.id)).toEqual(report.batches.map((batch) => batch.id));
    expect(rows.every((row) => row.kind === "batch")).toBe(true);
  });

  it("keeps a skipped batch at its own index instead of moving or dropping it", () => {
    const target = report.batches[1]!;
    const rows = queueRows(run(reportMessage("full"), { type: "skip-batch", batchId: target.id }));

    expect(rows).toHaveLength(report.batches.length);
    expect(rows[1]).toMatchObject({ kind: "skipped", id: target.id });
  });

  it("turns a bound batch into a receipt at the index the batch held", () => {
    // The re-lint after a bind deletes the batch — it isn't loose any more. The
    // receipt is what proves the row still reports its own outcome in place.
    const target = report.batches[1]!;
    const state = run(
      reportMessage("full"),
      { type: "applied", payload: appliedFor(target.id, "color.core_neu_00", target.count) },
      reportMessage("incremental", without(target.id)),
    );

    const rows = queueRows(state);
    expect(rows).toHaveLength(report.batches.length);
    expect(rows[1]).toMatchObject({ kind: "receipt", id: target.id, undoable: true });
    expect(rows[0]!.id).toBe(report.batches[0]!.id);
    expect(rows[2]!.id).toBe(report.batches[2]!.id);
  });

  it("offers Undo only on the fix still sitting on top of Figma's undo stack", () => {
    const first = report.batches[0]!;
    const second = report.batches[1]!;
    const state = run(
      reportMessage("full"),
      { type: "applied", payload: appliedFor(first.id, "color.core_neu_00", first.count) },
      reportMessage("incremental", without(first.id)),
      { type: "applied", payload: appliedFor(second.id, "color.core_sec_500", second.count) },
      reportMessage("incremental", {
        ...report,
        batches: report.batches.filter((b) => b.id !== first.id && b.id !== second.id),
      }),
    );

    const rows = queueRows(state);
    // Both receipts sit where their rows were — and in the order they were
    // bound, which the recorded indices alone do not say.
    expect(rows.map((row) => row.id)).toEqual(report.batches.map((batch) => batch.id));
    const receipts = rows.filter((row) => row.kind === "receipt");
    expect(receipts).toHaveLength(2);
    expect(receipts.map((row) => row.kind === "receipt" && row.undoable)).toEqual([false, true]);
  });

  it("puts a receipt's row back when the value goes loose again", () => {
    // Somebody unbound it, or an undo landed. The batch is in the report again,
    // so it has to be a card again — two rows for one value would be a lie.
    const target = report.batches[1]!;
    const state = run(
      reportMessage("full"),
      { type: "applied", payload: appliedFor(target.id, "color.core_neu_00", target.count) },
      reportMessage("incremental", without(target.id)),
      reportMessage("incremental"),
    );

    const rows = queueRows(state);
    expect(rows).toHaveLength(report.batches.length);
    expect(rows[1]).toMatchObject({ kind: "batch", id: target.id });
  });

  it("records nothing for an apply that bound zero layers", () => {
    const target = report.batches[0]!;
    const state = run(reportMessage("full"), {
      type: "applied",
      payload: { ...appliedFor(target.id, "color.core_neu_00", 0), undoable: false },
    });
    expect(state.resolved).toHaveLength(0);
  });

  it("does not give autofix a receipt — it spans batches and owns no row", () => {
    const state = run(reportMessage("full"), {
      type: "applied",
      payload: { ...appliedFor("autofix", "3 tokens", 42), label: "Autofix · 3 batches" },
    });
    expect(state.resolved).toHaveLength(0);
    expect(state.applied?.applied).toBe(42);
  });
});

describe("the queue's view state", () => {
  it("keeps exactly one card open", () => {
    const first = report.batches[0]!.id;
    const second = report.batches[1]!.id;
    const state = run(
      reportMessage("full"),
      { type: "open-batch", batchId: first },
      { type: "open-batch", batchId: second },
    );
    expect(state.openBatchId).toBe(second);

    const closed = reduce(state, { type: "open-batch", batchId: second });
    expect(closed.openBatchId).toBeNull();
  });

  it("closes the card and forgets the skip when its batch is bound", () => {
    const target = report.batches[0]!;
    const state = run(
      reportMessage("full"),
      { type: "skip-batch", batchId: target.id },
      { type: "open-batch", batchId: target.id },
      { type: "applied", payload: appliedFor(target.id, "color.core_neu_00", target.count) },
    );
    expect(state.openBatchId).toBeNull();
    expect(state.skipped).toEqual([]);
  });

  it("survives the incremental re-lint that follows a bind", () => {
    const kept = report.batches[2]!;
    const state = run(
      reportMessage("full"),
      { type: "skip-batch", batchId: kept.id },
      reportMessage("incremental"),
    );
    expect(state.skipped).toEqual([kept.id]);
  });

  it("starts over on a full re-lint, which is a fresh reading of the page", () => {
    const target = report.batches[0]!;
    const state = run(
      reportMessage("full"),
      { type: "skip-batch", batchId: target.id },
      { type: "applied", payload: appliedFor(report.batches[1]!.id, "space.4", 2) },
      reportMessage("full"),
    );
    expect(state.skipped).toEqual([]);
    expect(state.resolved).toEqual([]);
    expect(state.openBatchId).toBeNull();
    expect(state.picks).toEqual({});
  });

  it("drops a pick whose batch is gone and keeps one whose batch is not", () => {
    const gone = report.batches[0]!;
    const kept = report.batches[1]!;
    const state = run(
      reportMessage("full"),
      { type: "pick-candidate", batchId: gone.id, tokenRef: "color.core_neu_00" },
      { type: "pick-candidate", batchId: kept.id, tokenRef: "color.core_sec_500" },
      reportMessage("incremental", without(gone.id)),
    );
    expect(state.picks).toEqual({ [kept.id]: "color.core_sec_500" });
  });

  it("measures session movement from where the session started, not the last report", () => {
    const start = reduce(initialState, reportMessage("full"));
    expect(start.sessionBasePercent).toBe(report.coverage.percent);

    const later = reduce(start, {
      ...(reportMessage("incremental") as Extract<PluginMessage, { type: "report" }>),
      report: { ...report, coverage: { ...report.coverage, percent: 91 } },
    });
    expect(later.sessionBasePercent).toBe(report.coverage.percent);
    expect(later.previousPercent).toBe(report.coverage.percent);
  });
});

describe("what a card offers", () => {
  it("pre-selects an exact match, because Studio measured it", () => {
    const exact = report.batches.find((batch) => {
      const proposal = batch.proposal;
      return proposal !== null && isFixProposal(proposal) && proposal.kind === "exact";
    });
    expect(exact).toBeDefined();

    const picked = pickedCandidate(exact!, {});
    expect(picked?.tokenRef).toBe((exact!.proposal as { tokenRef: string }).tokenRef);
    expect(bindAction(exact!, picked)).toMatchObject({ kind: "bind" });
  });

  it("pre-selects nothing on a near match, and will not offer Bind until you pick", () => {
    // The card's own copy says Studio won't choose. A pre-checked radio would
    // make that a lie, and a ΔE of 4 across 36 layers is not Studio's call.
    const near = report.batches.find((batch) => {
      const proposal = batch.proposal;
      return proposal !== null && isFixProposal(proposal) && proposal.kind === "near";
    });
    expect(near).toBeDefined();

    expect(pickedCandidate(near!, {})).toBeNull();
    expect(bindAction(near!, null)).toMatchObject({ kind: "pick", label: "Pick a token" });

    const chosen = near!.proposal as { candidates: Array<{ tokenRef: string }> };
    const first = chosen.candidates[0]!.tokenRef;
    const picked = pickedCandidate(near!, { [near!.id]: first });
    expect(picked?.tokenRef).toBe(first);
    expect(bindAction(near!, picked).kind).toBe("bind");
  });

  it("offers Add, not Bind, when the token has no variable in this file", () => {
    const unbindable = lint(
      document(withDepths(node({ layoutMode: "vertical", children: [node({ fill: looseFill("#ffffff") })] }))),
      context({ theme: themeSnapshot({ bindable: () => false }) }),
    );
    const batch = unbindable.batches[0]!;
    const action = bindAction(batch, pickedCandidate(batch, {}));
    expect(action.kind).toBe("add");
    if (action.kind === "add") expect(action.label.startsWith("Add ")).toBe(true);
  });

  it("offers no button at all when the theme has no token for the value", () => {
    // A disabled button promises that something would happen if the state were
    // right. Here nothing would: the way forward is a token decision outside
    // this panel, and a greyed button reads as a broken plugin instead.
    const stuck = lint(
      document(withDepths(node({ layoutMode: "vertical", children: [node({ radius: loose(93) })] }))),
      context({ theme: snapshot }),
    ).batches[0];
    expect(stuck).toBeDefined();
    expect(isActionable(stuck!)).toBe(false);
    expect(bindAction(stuck!, null)).toMatchObject({ kind: "none" });
  });

  it("never says the token twice on one 390px line", () => {
    // The engine's evidence stands alone — `12px === space.3`. Beside the token
    // it names, that is the same fact printed twice and the row runs out of room.
    for (const batch of report.batches) {
      const proposal = batch.proposal;
      if (!proposal || !isFixProposal(proposal)) continue;
      const line = targetLine(batch);
      expect(line.token).toBe(proposal.tokenRef);
      expect(line.note).not.toContain(proposal.tokenRef);
      expect(line.note.length).toBeGreaterThan(0);
    }
  });

  it("hands back a sentence with no token when there is nothing to propose", () => {
    // The card sets a token in monospace and a sentence in Inter. It can only do
    // that if the two arrive separately.
    const stuck = lint(
      document(withDepths(node({ layoutMode: "vertical", children: [node({ fill: looseFill("image") })] }))),
      context({ theme: snapshot }),
    ).batches[0];

    if (stuck && !isActionable(stuck)) {
      const line = targetLine(stuck);
      expect(line.token).toBeNull();
      expect(line.note.length).toBeGreaterThan(0);
    }
  });

  it("gives a colour a swatch and everything else a letter", () => {
    const fill = report.batches.find((batch) => batch.currentValue.startsWith("#"))!;
    expect(tileGlyph(fill)).toEqual({ swatch: fill.currentValue, letter: "" });

    const radius = report.batches.find((batch) => batch.scope === "radius");
    if (radius) expect(tileGlyph(radius)).toEqual({ swatch: null, letter: "R" });
  });
});
