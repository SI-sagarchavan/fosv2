/**
 * The fix queue — the product — as cards.
 *
 * A card is a decision, and the panel's rule is that a decision resolves where
 * it was taken. Bind and the card becomes the receipt for its own bind. Skip and
 * it stays, greyed, with the way back on it. Nothing is appended, nothing below
 * moves, and the queue you were reading is still the queue in front of you.
 *
 * One card is open at a time. Two open cards on a 390px panel is a scroll
 * position you have to maintain by hand, and the second one is never the one you
 * were deciding about.
 */
import type { JSX } from "react";
import { isFixProposal } from "../health/types.js";
import type { Batch, FixCandidate } from "../health/types.js";
import { send } from "./main.js";
import type { PanelAction, ResolvedRow, StudioState } from "./state.js";
import {
  bindAction,
  candidatesOf,
  hintFor,
  impactShare,
  isActionable,
  missingRefs,
  queueRows,
  targetLine,
  tileGlyph,
} from "./rows.js";

export function FixQueue({
  state,
  dispatch,
}: {
  state: StudioState;
  dispatch: (action: PanelAction) => void;
}): JSX.Element | null {
  const report = state.report;
  if (!report) return null;

  const rows = queueRows(state);

  if (rows.length === 0) {
    return (
      <div className="queue-empty">
        <div style={{ fontWeight: 600 }}>Nothing loose on this page.</div>
        <div className="muted">Every fill, spacing and radius here is bound to a token.</div>
      </div>
    );
  }

  const open = rows.filter((row) => row.kind === "batch").length;
  const covered = report.batches
    .slice(0, report.batchesFor90Percent)
    .reduce((sum, batch) => sum + batch.count, 0);
  const share = report.coverage.loose > 0 ? Math.round((covered / report.coverage.loose) * 100) : 0;

  return (
    <>
      <div className="qhead">
        <span className="grow">
          Loose values <span className="muted">{open}</span>
        </span>
        {report.batches.length > 0 ? (
          <span className="muted">
            top {report.batchesFor90Percent} cover {share}%
          </span>
        ) : null}
      </div>

      {rows.map((row) =>
        row.kind === "receipt" ? (
          <Receipt key={row.id} row={row.row} undoable={row.undoable} busy={state.busy} />
        ) : row.kind === "skipped" ? (
          <Skipped key={row.id} batch={row.batch} dispatch={dispatch} />
        ) : (
          <Card
            key={row.id}
            batch={row.batch}
            open={row.open}
            picked={row.picked}
            batches={report.batches}
            busy={state.busy}
            dispatch={dispatch}
          />
        ),
      )}
    </>
  );
}

/**
 * A loose value. Closed it is a claim — this much, worth this much. Open it is
 * the evidence and the two ways out.
 */
function Card({
  batch,
  open,
  picked,
  batches,
  busy,
  dispatch,
}: {
  batch: Batch;
  open: boolean;
  picked: FixCandidate | null;
  batches: readonly Batch[];
  busy: boolean;
  dispatch: (action: PanelAction) => void;
}): JSX.Element {
  const glyph = tileGlyph(batch);
  const candidates = candidatesOf(batch);
  const action = bindAction(batch, picked);
  const target = targetLine(batch);
  const actionable = isActionable(batch);

  return (
    <div className={open ? "card card-open" : "card"}>
      <button
        className="card-head"
        aria-expanded={open}
        title={target.token ? `→ ${target.token} · ${target.note}` : target.note}
        onClick={() => dispatch({ type: "open-batch", batchId: batch.id })}
      >
        <span
          className="tile"
          style={glyph.swatch ? { background: glyph.swatch } : undefined}
          aria-hidden
        >
          {glyph.letter}
        </span>

        <span className="card-main">
          <span className="card-title">
            <ValueText className="card-value truncate" value={batch.currentValue} />
            <span className="card-layers">
              {batch.count} {batch.count === 1 ? "layer" : "layers"}
            </span>
          </span>
          <span className="truncate card-target">
            <span className="arrow">→</span>
            {target.token ? (
              <>
                <span className="mono card-token">{target.token}</span>
                {target.note ? <TargetNote note={target.note} /> : null}
              </>
            ) : (
              <span className="card-note">{target.note}</span>
            )}
          </span>
        </span>

        {/* Muted when nothing on this row can be pressed. It is still worth the
            points — that is why it ranks here — but green would promise a fix
            that does not exist behind it. */}
        <span className={actionable ? "card-impact" : "card-impact is-inert"}>
          <span className="gain">+{batch.coverageGain}%</span>
          <span className="impact-track">
            <span
              className="impact-fill"
              style={{ width: `${Math.round(impactShare(batch, batches) * 100)}%` }}
            />
          </span>
        </span>
      </button>

      {open ? (
        <div className="card-body">
          <div className="card-hint">{hintFor(batch)}</div>

          {candidates.map((candidate) => (
            <button
              key={candidate.tokenRef}
              className={
                picked && picked.tokenRef === candidate.tokenRef ? "cand cand-on" : "cand"
              }
              onClick={() =>
                dispatch({ type: "pick-candidate", batchId: batch.id, tokenRef: candidate.tokenRef })
              }
              title={
                candidate.bindable
                  ? `Bind all ${batch.count} to ${candidate.tokenRef}`
                  : `${candidate.tokenRef} has no Figma variable in this file yet`
              }
            >
              <span className="radio" aria-hidden />
              {candidate.value.startsWith("#") ? (
                <span className="swatch" style={{ background: candidate.value }} aria-hidden />
              ) : null}
              <span className="cand-main">
                <span className="mono cand-ref truncate">{candidate.tokenRef}</span>
                <span className="cand-evidence">
                  <ValueText className="cand-hex" value={candidate.value} />
                  {candidate.value.startsWith("#") ? (
                    <span className="delta">ΔE {candidate.distance}</span>
                  ) : null}
                  {candidate.bindable ? null : <span className="cand-add">add</span>}
                </span>
              </span>
            </button>
          ))}

          <button
            className="card-select"
            onClick={() => send({ type: "select-batch", batchId: batch.id })}
          >
            Select {batch.count} {batch.count === 1 ? "layer" : "layers"} on canvas →
          </button>

          <div className="card-actions">
            <PrimaryAction batch={batch} picked={picked} busy={busy} action={action} />
            <button
              className={action.kind === "none" ? "outline grow" : "outline"}
              onClick={() => dispatch({ type: "skip-batch", batchId: batch.id })}
              title="Puts this row aside for now. Nothing is written."
            >
              Skip
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PrimaryAction({
  batch,
  picked,
  busy,
  action,
}: {
  batch: Batch;
  picked: FixCandidate | null;
  busy: boolean;
  action: ReturnType<typeof bindAction>;
}): JSX.Element | null {
  if (action.kind === "bind") {
    return (
      <button
        className="primary grow"
        disabled={busy}
        title={action.title}
        onClick={() =>
          send({ type: "apply-candidate", batchId: batch.id, tokenRef: action.tokenRef })
        }
      >
        {action.label}
      </button>
    );
  }

  if (action.kind === "add") {
    const proposal = batch.proposal;
    const refs =
      picked && !picked.bindable
        ? [picked.tokenRef]
        : proposal && isFixProposal(proposal)
          ? missingRefs(proposal)
          : [];
    return (
      <button
        className="outline grow"
        disabled={busy || refs.length === 0}
        title={action.title}
        onClick={() => send({ type: "create-variables", refs })}
      >
        {action.label}
      </button>
    );
  }

  if (action.kind === "pick") {
    return (
      <button className="primary grow is-waiting" disabled title={action.title}>
        {action.label}
      </button>
    );
  }

  // kind === "none": nothing to press. The card's explanation is the answer, and
  // Skip is the only move — so Skip gets the row to itself.
  return null;
}

/**
 * The receipt. Same row, same place — it is what the card became.
 *
 * Undo shows only while this is still the top of Figma's undo stack. An older
 * one is a record, and a button that cannot do what it says is worse than none.
 */
function Receipt({
  row,
  undoable,
  busy,
}: {
  row: ResolvedRow;
  undoable: boolean;
  busy: boolean;
}): JSX.Element {
  return (
    <div className="card card-done">
      <span className="done-tick" aria-hidden>
        ✓
      </span>
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="mono truncate done-token">{row.tokenRef}</span>
        <span className="done-meta truncate">
          {row.count} {row.count === 1 ? "layer" : "layers"} bound · +{row.gain}%
          {row.failed > 0 ? ` · ${row.failed} failed` : ""}
        </span>
      </span>
      {undoable ? (
        <button className="link" disabled={busy} onClick={() => send({ type: "undo-last" })}>
          Undo
        </button>
      ) : null}
    </div>
  );
}

/** Put aside. Nothing was written, so the way back is a panel action, not an undo. */
function Skipped({
  batch,
  dispatch,
}: {
  batch: Batch;
  dispatch: (action: PanelAction) => void;
}): JSX.Element {
  return (
    <div className="card card-skipped">
      <ValueText className="truncate grow" value={`${batch.currentValue} · skipped`} />
      <button
        className="link"
        onClick={() => dispatch({ type: "unskip-batch", batchId: batch.id })}
      >
        Undo
      </button>
    </div>
  );
}

/** Hex keeps the hash quiet so the digits are what you read. Anything else is a name. */
function ValueText({ value, className }: { value: string; className?: string }): JSX.Element {
  const hex = value.match(/^(#)([0-9a-fA-F]{3,8})(.*)$/);
  if (hex) {
    return (
      <span className={`mono ${className ?? ""}`.trim()}>
        <span className="hash">#</span>
        {hex[2]}
        {hex[3]}
      </span>
    );
  }
  return <span className={`mono ${className ?? ""}`.trim()}>{value}</span>;
}

function TargetNote({ note }: { note: string }): JSX.Element {
  if (note.startsWith("#")) return <ValueText className="card-note" value={note} />;
  if (note.startsWith("ΔE") || note === "exact") {
    return <span className={note === "exact" ? "delta delta-exact" : "delta"}>{note}</span>;
  }
  return <span className="card-note">{note}</span>;
}
