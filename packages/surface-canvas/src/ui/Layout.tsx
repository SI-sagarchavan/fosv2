/**
 * Layout tab — the sizing contract for SSR and data bindings.
 *
 * Tokens answer colour. This answers who owns the size: hug grows with copy,
 * fill takes leftover space, fixed is a photograph. Pinned text (auto-resize
 * off) will clip when `{headline}` is longer than the design string.
 */
import type { JSX } from "react";
import type { PinnedText } from "../health/sizing.js";
import { send } from "./main.js";
import { StatusLine } from "./StatusLine.js";
import type { StudioState } from "./state.js";

export function LayoutTab({ state }: { state: StudioState }): JSX.Element {
  const sizing = state.report?.sizing;

  if (!sizing) {
    return (
      <div className="section">
        <div className="muted">{state.status || "Reading the page…"}</div>
      </div>
    );
  }

  const pinned = sizing.pinnedText;
  const { hug, fill, fixed, total } = sizing.axes;

  return (
    <>
      <div className="section coverage">
        <div className="row">
          <span className="score">{pinned.length === 0 ? "Ready" : pinned.length}</span>
          <span className="grow muted" style={{ marginLeft: 8 }}>
            {pinned.length === 0
              ? "Text already hugs — bindings can grow the box"
              : `${pinned.length === 1 ? "text layer is" : "text layers are"} pinned. Longer copy will clip.`}
          </span>
        </div>
        <div className="bar" style={{ marginTop: 8 }}>
          <div className="bar-bound" style={{ width: total ? `${(hug / total) * 100}%` : 0 }} title="hug" />
          <div className="bar-ready" style={{ width: total ? `${(fill / total) * 100}%` : 0 }} title="fill" />
        </div>
        <div className="muted" style={{ marginTop: 6 }}>
          {hug} hug · {fill} fill · {fixed} fixed
          {sizing.textTotal > 0
            ? ` · ${sizing.huggingText}/${sizing.textTotal} text hugs`
            : ""}
        </div>
      </div>

      <div className="scroll">
        {/* Same one line as Health. Hugging text is an undoable change too, and
            it must report itself in the place the panel always reports. */}
        <div style={{ marginTop: 10 }}>
          <StatusLine state={state} />
        </div>
        {pinned.length === 0 ? (
          <div className="section muted">Nothing to hug on this frame.</div>
        ) : (
          pinned.map((item) => <PinnedRow key={item.nodeId} item={item} busy={state.busy} />)
        )}
      </div>

      {pinned.length > 0 ? (
        <div className="footer">
          <button
            className="primary grow"
            disabled={state.busy}
            onClick={() => send({ type: "hug-text" })}
            title="Sets text auto-resize to height. Width stays. One undo reverts all of it."
          >
            Hug {pinned.length} {pinned.length === 1 ? "text layer" : "text layers"}
          </button>
        </div>
      ) : null}
    </>
  );
}

function PinnedRow({ item, busy }: { item: PinnedText; busy: boolean }): JSX.Element {
  return (
    <div className="batch">
      <div className="row">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="truncate" style={{ fontWeight: 600 }}>
            {item.name}
          </div>
          <div className="muted">
            {Math.round(item.w)}×{Math.round(item.h)}
            {item.lines > 1 ? ` · ${item.lines} lines` : ""} · auto-resize off
          </div>
        </div>
        <button
          className="ghost compact"
          onClick={() => send({ type: "select-nodes", nodeIds: [item.nodeId] })}
        >
          Select
        </button>
        <button
          className="outline compact"
          disabled={busy}
          onClick={() => send({ type: "hug-text", nodeIds: [item.nodeId] })}
          title="Hug height. Width stays so a column doesn't blow out."
        >
          Hug
        </button>
      </div>
    </div>
  );
}
