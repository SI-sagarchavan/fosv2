/**
 * The panel — coverage-led.
 *
 * The score leads because it is a proportion and it moves: the ring says how
 * much of this frame is described by tokens, and the queue under it is the list
 * of the specific things that would move it, each carrying its own payoff in the
 * same units. A percentage on its own is a grade. A percentage with the levers
 * underneath it is a piece of work.
 *
 * Everything below the ring resolves in place. One status line for the last
 * action, one card open at a time, and a bind that turns its own row into the
 * receipt for itself. Nothing an action does ever appends a block, so the queue
 * never moves under somebody who is reading it.
 */
import type { JSX } from "react";
import { useState } from "react";
import { isFixProposal } from "../health/types.js";
import type { Tab } from "../protocol.js";
import { send } from "./main.js";
import { AssetsTab } from "./Assets.js";
import { PreviewPanel } from "./Preview.js";
import { Coverage } from "./Coverage.js";
import { ExportTab } from "./Export.js";
import { FixQueue } from "./FixQueue.js";
import { Header } from "./Header.js";
import { Reconciliation } from "./Reconciliation.js";
import { StatusLine } from "./StatusLine.js";
import type { PanelAction, StudioState } from "./state.js";

export function App({
  state,
  dispatch,
  stalled = false,
}: {
  state: StudioState;
  dispatch: (action: PanelAction) => void;
  stalled?: boolean;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>("health");

  if (state.panelState === "collapsed") return <Collapsed state={state} />;

  return (
    <>
      <Header state={state} />

      {stalled ? (
        <div className="section" style={{ color: "var(--fos-danger)" }}>
          The plugin didn't answer. Close and reopen it — and if it happens again,
          check the console (Plugins → Development → Open console) for a startup
          error.
        </div>
      ) : null}

      <div className="tabs">
        <button
          className="tab"
          aria-selected={tab === "health"}
          onClick={() => setTab("health")}
        >
          Health
        </button>
        <button
          className="tab"
          aria-selected={tab === "assets"}
          onClick={() => setTab("assets")}
        >
          Assets
          {state.assets.length > 0 ? (
            <span className="tab-count">{state.assets.length}</span>
          ) : null}
        </button>
        <button
          className="tab"
          aria-selected={tab === "preview"}
          onClick={() => setTab("preview")}
        >
          Preview
        </button>
        <button
          className="tab"
          aria-selected={tab === "export"}
          onClick={() => setTab("export")}
        >
          Export
        </button>
      </div>

      {state.error ? (
        <div className="section" style={{ color: "var(--fos-danger)" }}>
          {state.error}
        </div>
      ) : null}

      <div className="tab-body">
        {tab === "health" ? (
          <HealthTab state={state} dispatch={dispatch} />
        ) : tab === "assets" ? (
          <AssetsTab state={state} dispatch={dispatch} />
        ) : tab === "preview" ? (
          <div className="scroll">
            <PreviewPanel state={state} />
          </div>
        ) : (
          <ExportTab state={state} />
        )}
      </div>
    </>
  );
}

function HealthTab({
  state,
  dispatch,
}: {
  state: StudioState;
  dispatch: (action: PanelAction) => void;
}): JSX.Element {
  const report = state.report;

  return (
    <>
      {/* Ring and status line scroll with the queue rather than pinning above
          it. On a 720px panel a fixed header plus a fixed footer leaves the
          cards a slot too short to hold an open one, and the score is not what
          you are looking at while you work through the queue. */}
      <div className="scroll">
        <Coverage state={state} />
        <StatusLine state={state} />
        <FixQueue state={state} dispatch={dispatch} />
        <PinnedText state={state} />
        <Reconciliation reconciliation={state.reconciliation} />
      </div>

      <div className="footer">
        <button
          className={state.heatmapOn ? "primary" : "outline"}
          onClick={() => send({ type: "toggle-heatmap", on: !state.heatmapOn })}
          disabled={!report}
          title="Tints every layer on canvas: green bound, red loose, amber inside a blocker"
        >
          {state.heatmapOn ? `Heatmap · ${state.heatmapNodes}` : "Heatmap"}
        </button>
        <Autofix state={state} />
      </div>
    </>
  );
}

/**
 * Text that cannot grow.
 *
 * The one thing the Layout tab was carrying that is worth keeping. A text layer
 * with auto-resize off is a fixed box: the moment `{headline}` is longer than
 * the string the designer typed, the copy clips. That is invisible in Figma —
 * the design string always fits — and only shows up once real data arrives.
 *
 * One line and one button rather than a tab, because it is a check, not a
 * workspace. Silent when there is nothing pinned, which on a healthy frame is
 * most of the time.
 */
function PinnedText({ state }: { state: StudioState }): JSX.Element | null {
  const pinned = state.report?.sizing?.pinnedText ?? [];
  if (pinned.length === 0) return null;

  return (
    <div className="section">
      <div className="row">
        <span className="grow" style={{ color: "var(--fos-warn)" }}>
          {pinned.length} {pinned.length === 1 ? "text layer is" : "text layers are"} pinned —
          longer copy will clip
        </span>
        <button
          className="outline"
          disabled={state.busy}
          onClick={() => send({ type: "hug-text" })}
          title="Sets text auto-resize to height. Width stays. One undo reverts all of it."
        >
          Hug {pinned.length}
        </button>
      </div>
    </div>
  );
}

/**
 * Autofix — the one action that stands for the whole queue.
 *
 * It applies exactly the batches already marked safe: exact value match, real
 * variable behind the token. That set is what the dashed segment of the coverage
 * bar is counting, so the payoff on this button and the gap on the bar are the
 * same number by construction.
 *
 * It is deliberately NOT a shortcut around review. Near matches stay out of it,
 * and the label says how many are waiting, so "autofix" never quietly means
 * "guessed at 36 layers of your brand red".
 */
function Autofix({ state }: { state: StudioState }): JSX.Element | null {
  const report = state.report;
  if (!report) return null;

  const safe = report.batches.filter((batch) => batch.safe);
  const layers = safe.reduce((sum, batch) => sum + batch.count, 0);
  const reviewable = report.batches.filter(
    (batch) => batch.proposal && isFixProposal(batch.proposal) && batch.proposal.kind === "near",
  ).length;

  // Exact matches whose token simply does not exist here. Creating them is the
  // unlock, and it is a different promise from binding — so it gets its own
  // button and its own words, never a silent step inside Autofix.
  const creatable = new Set<string>();
  for (const batch of report.batches) {
    const proposal = batch.proposal;
    if (!proposal || !isFixProposal(proposal)) continue;
    if (proposal.bindable) continue;
    if (proposal.kind === "exact" || proposal.kind === "near") creatable.add(proposal.tokenRef);
  }

  if (layers === 0) {
    if (creatable.size > 0) {
      return (
        <button
          className="primary grow"
          disabled={state.busy}
          onClick={() => send({ type: "create-variables" })}
          title={`Creates ${[...creatable].join(", ")} with the theme's values, then re-checks`}
        >
          Add {creatable.size} {creatable.size === 1 ? "variable" : "variables"}
        </button>
      );
    }
    return (
      <span className="muted grow" style={{ textAlign: "right" }}>
        {reviewable > 0
          ? `${reviewable} ${reviewable === 1 ? "batch needs" : "batches need"} a pick`
          : "Nothing safe to bind automatically"}
      </span>
    );
  }

  return (
    <button
      className="primary grow"
      disabled={state.busy}
      onClick={() => send({ type: "autofix" })}
      title={[
        `Binds ${layers} layers across ${safe.length} ${safe.length === 1 ? "batch" : "batches"}, in one undo step:`,
        ...safe.map((batch) => `  ${batch.count} × ${batch.label} → ${tokenOf(batch)}`),
        reviewable > 0
          ? `\n${reviewable} near-match ${reviewable === 1 ? "batch" : "batches"} left for you to review.`
          : "",
      ]
        .filter(Boolean)
        .join("\n")}
    >
      Bind {layers} exact +{report.coverage.oneClickPercent}%
    </button>
  );
}

function tokenOf(batch: { proposal: unknown }): string {
  const proposal = batch.proposal as { tokenRef?: string } | null;
  return proposal?.tokenRef ?? "—";
}

/**
 * Collapsed bar. Everything a designer needs to decide whether to open it again:
 * where the score is, and whether generation is blocked.
 *
 * It also has to be able to say "working" and "broken". A collapsed panel that
 * can only ever render a number is a dead box when something goes wrong, and the
 * only way out is to expand it and hope.
 */
function Collapsed({ state }: { state: StudioState }): JSX.Element {
  const report = state.report;
  const blockers = report?.blockers.length ?? 0;

  const summary = state.error ? (
    <span style={{ color: "var(--fos-danger)" }}>Something went wrong — expand</span>
  ) : state.busy ? (
    <span className="muted">{state.status || "Working…"}</span>
  ) : report ? (
    <>
      <strong>{report.coverage.total === 0 ? "—" : `${report.coverage.percent}%`}</strong>
      <span className="muted"> · </span>
      <span style={{ color: blockers > 0 ? "var(--fos-danger)" : "var(--fos-text-secondary)" }}>
        {blockers} {blockers === 1 ? "blocker" : "blockers"}
      </span>
    </>
  ) : (
    <span className="muted">Starting…</span>
  );

  return (
    <div className="collapsed">
      <button
        className="ghost"
        onClick={() => send({ type: "set-panel-state", state: "expanded" })}
        title="Expand"
      >
        ›
      </button>
      <span className="grow truncate">{summary}</span>
    </div>
  );
}
