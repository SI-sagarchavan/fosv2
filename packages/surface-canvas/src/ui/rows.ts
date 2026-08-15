/**
 * The queue, as the coverage-led panel draws it.
 *
 * PURE — no React, no Figma. It turns (report + what the panel remembers) into
 * an ordered list of cards, so the one property the layout rests on is testable
 * without a DOM: nothing an action does ever appends a block. A skipped batch
 * stays a row where it was. A bound batch becomes a receipt where it was, even
 * though the re-lint that follows the bind has already deleted it.
 */
import type { Batch, FixCandidate, FixProposal } from "../health/types.js";
import { isFixProposal } from "../health/types.js";
import type { ResolvedRow, StudioState } from "./state.js";

export type QueueRow =
  /** Still loose. `open` is the one expanded card; at most one ever is. */
  | { kind: "batch"; id: string; batch: Batch; open: boolean; picked: FixCandidate | null }
  /** Put aside for now. Nothing was written; Undo just puts it back. */
  | { kind: "skipped"; id: string; batch: Batch }
  /** Bound. The row it replaced sat at this position. */
  | { kind: "receipt"; id: string; row: ResolvedRow; undoable: boolean };

/**
 * Live batches in queue order, with the receipts spliced back in where their
 * batch was.
 *
 * Each receipt's index was read from the report that was on screen when it was
 * bound, and every bind before it had already removed a batch from that report —
 * so the recorded indices are all shifted down by however many receipts precede
 * them. Inserting in ascending order and adding the running count back puts each
 * one where its row actually was. Without that, two binds in a row swap places.
 */
export function queueRows(state: StudioState): QueueRow[] {
  const batches = state.report?.batches ?? [];
  const skipped = new Set(state.skipped);

  const rows: QueueRow[] = batches.map((batch) =>
    skipped.has(batch.id)
      ? { kind: "skipped", id: batch.id, batch }
      : {
          kind: "batch",
          id: batch.id,
          batch,
          open: state.openBatchId === batch.id,
          picked: pickedCandidate(batch, state.picks),
        },
  );

  const applied = state.applied;
  // Stable sort, so receipts recorded against the same index stay in the order
  // they were bound in.
  const receipts = [...state.resolved].sort((a, b) => a.index - b.index);
  for (let i = 0; i < receipts.length; i++) {
    const row = receipts[i]!;
    // Figma's undo is a stack, so only the fix still on top of it can honestly
    // offer Undo. An older receipt is a record, not a button.
    const undoable = applied !== null && applied.batchId === row.batchId && applied.undoable;
    rows.splice(Math.min(row.index + i, rows.length), 0, {
      kind: "receipt",
      id: row.batchId,
      row,
      undoable,
    });
  }

  return rows;
}

/** The tokens this batch could bind to. Empty when there is no fix at all. */
export function candidatesOf(batch: Batch): FixCandidate[] {
  const proposal = batch.proposal;
  if (!proposal || !isFixProposal(proposal)) return [];
  return proposal.candidates;
}

/**
 * What the card's radios have selected.
 *
 * An exact match arrives pre-selected — Studio measured it, there is nothing to
 * decide. A near match does not, and the button stays off until somebody picks:
 * a ΔE of 4 is a question for a designer, not a licence to repaint 36 layers.
 */
export function pickedCandidate(
  batch: Batch,
  picks: Record<string, string>,
): FixCandidate | null {
  const candidates = candidatesOf(batch);
  if (candidates.length === 0) return null;

  const chosen = picks[batch.id];
  if (chosen) return candidates.find((candidate) => candidate.tokenRef === chosen) ?? null;

  const proposal = batch.proposal;
  if (proposal && isFixProposal(proposal) && proposal.kind === "exact") {
    return candidates.find((candidate) => candidate.tokenRef === proposal.tokenRef) ?? candidates[0] ?? null;
  }
  return null;
}

export type BindAction =
  /** Bind the picked token across the batch. One undo step. */
  | { kind: "bind"; label: string; tokenRef: string; title: string }
  /** The token is right but this file has no variable for it. Different promise. */
  | { kind: "add"; label: string; tokenRef: string; title: string }
  /**
   * Waiting on the designer. The button is drawn and disabled, because picking a
   * candidate is what turns it on — it is an instruction, not a dead end.
   */
  | { kind: "pick"; label: string; title: string }
  /**
   * Nothing to press, ever. The card draws NO primary button here.
   *
   * A disabled button is a promise that something would happen if only the state
   * were right. For a batch the theme has no token for, that is false: the way
   * forward is a token decision outside this panel, and the explanation in the
   * card is the whole of what Studio has to say. Drawing a greyed "No token for
   * this" reads as a bug in the plugin rather than a gap in the theme.
   */
  | { kind: "none"; title: string };

export function bindAction(batch: Batch, picked: FixCandidate | null): BindAction {
  const proposal = batch.proposal;
  if (!proposal || !isFixProposal(proposal)) {
    return { kind: "none", title: batch.message };
  }
  if (!picked) {
    return {
      kind: "pick",
      label: "Pick a token",
      title: "Studio won't choose a near match for you.",
    };
  }
  const layers = `${batch.count} ${batch.count === 1 ? "layer" : "layers"}`;
  if (picked.bindable) {
    return {
      kind: "bind",
      label: `Bind ${layers}`,
      tokenRef: picked.tokenRef,
      title: `Binds all ${batch.count} to ${picked.tokenRef}, in one undo step`,
    };
  }
  return {
    kind: "add",
    label: `Add ${shortRef(picked.tokenRef)}`,
    tokenRef: picked.tokenRef,
    title:
      `Creates the Figma variable for ${picked.tokenRef} in this file with the theme's ` +
      "value, then re-checks. It does not bind anything on its own.",
  };
}

/** The 26px tile: a swatch when the value is a colour, a letter when it isn't. */
export function tileGlyph(batch: Batch): { swatch: string | null; letter: string } {
  if (batch.currentValue.startsWith("#")) return { swatch: batch.currentValue, letter: "" };
  switch (batch.scope) {
    case "radius":
      return { swatch: null, letter: "R" };
    case "padding":
      return { swatch: null, letter: "P" };
    case "gap":
      return { swatch: null, letter: "G" };
    case "text":
      return { swatch: null, letter: "T" };
    case "effect":
      return { swatch: null, letter: "E" };
    default:
      return { swatch: null, letter: "F" };
  }
}

/**
 * The line under the value: where it wants to go, and on what evidence.
 *
 * Split rather than pre-joined because the two halves are different kinds of
 * text. `token` is an identifier and gets the monospace face; when there is no
 * token the line is a sentence about why, and a sentence set in monospace is
 * slower to read for no gain. The card decides the faces; this decides the words.
 *
 * The engine's evidence is written to stand alone (`12px === space.3`), which
 * next to the token it names reads as the same fact twice on a 390px row. Here
 * the token is already on the line, so the note only carries what the token
 * doesn't: that it was exact, or how far off it is.
 */
export interface TargetLine {
  /** The proposed token, or null when there is nothing to propose. */
  token: string | null;
  note: string;
}

export function targetLine(batch: Batch): TargetLine {
  const proposal = batch.proposal;
  if (proposal && isFixProposal(proposal)) {
    return {
      token: proposal.tokenRef,
      note:
        proposal.kind === "exact"
          ? "exact"
          : proposal.evidence && !proposal.evidence.includes(proposal.tokenRef)
            ? proposal.evidence
            : (proposal.candidates[0]?.value ?? proposal.evidence ?? ""),
    };
  }
  if (proposal && proposal.kind === "none") return { token: null, note: proposal.reason };
  return { token: null, note: batch.message };
}

/**
 * Whether pressing anything on this row would change the file.
 *
 * A batch with no proposal is still worth coverage points, and the queue ranks
 * it by them — but drawing its payoff in the same green as a batch you can bind
 * promises an action that does not exist behind it.
 */
export function isActionable(batch: Batch): boolean {
  const proposal = batch.proposal;
  return proposal !== null && isFixProposal(proposal);
}

/** One sentence at the top of an open card: what the decision actually is. */
export function hintFor(batch: Batch): string {
  const proposal = batch.proposal;
  if (!proposal) return batch.message;
  if (proposal.kind === "none") return proposal.hint || proposal.reason;
  if (!isFixProposal(proposal)) return batch.message;

  if (proposal.kind === "exact") {
    return proposal.bindable
      ? `Exact match. Binding all ${batch.count} is one undo step.`
      : `${proposal.tokenRef} is the exact match, but this file has no variable for it yet. ` +
          "Adding it is what unlocks the bind.";
  }
  return proposal.candidates.some((candidate) => candidate.bindable)
    ? `Not an exact match, so Studio won't choose. Pick one and it binds all ${batch.count} — ` +
        "one undo step."
    : "The closest tokens live in the theme but not in this file. Add one and this batch turns on.";
}

/**
 * How long the impact bar runs, 0–1, relative to the biggest lever in the queue.
 *
 * Relative rather than absolute because the bar's job is ranking: on a clean page
 * where nothing is worth more than 0.4%, every bar being a stub says "give up",
 * when what it should say is "this one first".
 */
export function impactShare(batch: Batch, batches: readonly Batch[]): number {
  let top = 0;
  for (const item of batches) top = Math.max(top, item.coverageGain);
  if (top <= 0) return 0;
  return Math.max(0.06, Math.min(1, batch.coverageGain / top));
}

/** How the value reads on a candidate row — a hex with its ΔE, or just `16px`. */
export function candidateMeta(candidate: FixCandidate): string {
  if (candidate.value.startsWith("#")) return `${candidate.value} · ΔE ${candidate.distance}`;
  return candidate.value;
}

/** Tokens an open card is blocked on, for the create-variables call. */
export function missingRefs(proposal: FixProposal): string[] {
  const refs = new Set<string>();
  if (!proposal.bindable) refs.add(proposal.tokenRef);
  for (const candidate of proposal.candidates) {
    if (!candidate.bindable) refs.add(candidate.tokenRef);
  }
  return [...refs];
}

/** `color.core_sec_700` -> `core_sec_700`. Buttons are 11px and 390px wide. */
function shortRef(ref: string): string {
  const dot = ref.lastIndexOf(".");
  return dot === -1 ? ref : ref.slice(dot + 1);
}
