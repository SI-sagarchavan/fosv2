/**
 * Header: whose plugin this is, and which tenant it is checking against.
 *
 * The theme sits here as a chip with a live status dot, not behind a settings
 * screen: the same file gets checked against different tenants routinely, and
 * switching re-runs reconciliation and re-proposes every batch. It is a
 * first-class action, and the dot next to it is how you know the numbers on
 * screen finished being recalculated.
 *
 * The frame being checked moved down next to the ring, where the score it
 * produced is. Studio has to pick a frame and it can pick wrong — that line is
 * still how you find out, it is just no longer the first thing in the panel.
 */
import type { JSX } from "react";
import { send } from "./main.js";
import type { StudioState } from "./state.js";

export function Header({ state }: { state: StudioState }): JSX.Element {
  // A container is selected, and it isn't the one being checked. That is the
  // only moment re-targeting is a meaningful offer.
  const offerRetarget =
    state.selectionId !== null &&
    state.report !== null &&
    state.selectionId !== state.report.rootNodeId;

  return (
    <>
      <div className="head">
        <span className="head-name grow truncate">FanOS Surface Canvas</span>

        <ThemeChip state={state} />

        <button
          className="ghost"
          onClick={() => send({ type: "refresh" })}
          disabled={state.busy}
          title="Re-check this frame. Doesn't follow your selection."
        >
          ↻
        </button>
        <button
          className="ghost"
          onClick={() => send({ type: "set-panel-state", state: "collapsed" })}
          title="Collapse"
        >
          ⌄
        </button>
      </div>

      {offerRetarget ? (
        <div className="head-retarget">
          <button
            className="outline grow truncate"
            disabled={state.busy}
            onClick={() => send({ type: "retarget" })}
            title="Check the selected frame instead of the current one"
          >
            Check “{state.selectionName}” instead
          </button>
        </div>
      ) : null}
    </>
  );
}

/**
 * The tenant, as a chip.
 *
 * The chip is drawn, and a transparent native `<select>` sits over the whole of
 * it. A styled `<select>` cannot do this: Chromium reserves room for its own
 * arrow inside the control regardless of padding, so a long tenant name runs
 * under the arrow and the label ends up clipped mid-word. Overlaying keeps the
 * real control — native menu, keyboard, screen reader — and lets the visible
 * label truncate on our terms.
 */
function ThemeChip({ state }: { state: StudioState }): JSX.Element {
  const current = state.themes.find((theme) => theme.id === state.themeId);
  const disabled = state.busy || state.themes.length === 0;

  return (
    <span className={disabled ? "theme-chip is-disabled" : "theme-chip"}>
      <span
        className="dot"
        style={{ background: state.busy ? "var(--fos-warn)" : "var(--fos-success)" }}
        title={state.busy ? state.status || "Working…" : "Up to date"}
        aria-hidden
      />
      <span className="theme-name truncate">{current?.name ?? "No theme"}</span>
      <span className="chev" aria-hidden>
        ⌄
      </span>
      <select
        value={state.themeId}
        disabled={disabled}
        onChange={(event) => send({ type: "select-theme", themeId: event.target.value })}
        aria-label="Theme"
        title="Re-runs reconciliation and re-proposes every batch"
      >
        {state.themes.map((theme) => (
          <option key={theme.id} value={theme.id}>
            {theme.name}
          </option>
        ))}
      </select>
    </span>
  );
}
