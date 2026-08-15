/**
 * The panel's state, and the one reducer that moves it.
 *
 * Pure, so the message handling is testable without a DOM: every sandbox message
 * in, one new state out.
 *
 * It also holds the queue's own view state — which card is open, which candidate
 * is picked, what was skipped, what resolved where. That is deliberate. The
 * panel's rule is that no action ever appends a block: a bind turns its own row
 * into the receipt for itself, and one status line carries the last action. Both
 * of those are memory that outlives the re-lint which erases the batch, so they
 * cannot live in a component that unmounts with it — and keeping them here means
 * the whole interaction is testable without a DOM, same as the messages.
 */
import type { LintReport } from "../health/types.js";
import type { ReconciliationReport } from "../health/reconcile-report.js";
import type {
  ActivityActor,
  ActivityEntry,
  AppliedPayload,
  ExportPublish,
  PanelState,
  PluginMessage,
} from "../protocol.js";
import type { ThemeChoice } from "../themes.js";

export interface ExportPayload {
  jsonName: string;
  json: string;
  screenshots: Array<{ name: string; nodeId: string; bytes: Uint8Array }>;
  summary: Record<string, unknown>;
}

/**
 * A batch that was bound, remembered at the position it held in the queue.
 *
 * The re-lint that follows a bind deletes the batch — it is not loose any more —
 * so without this the row would simply vanish and the confirmation would have to
 * appear somewhere else, as a new block. This is what lets the row report its own
 * outcome in place.
 */
export interface ResolvedRow {
  batchId: string;
  /** `fill #ffffff` — what the row said before it was bound. */
  label: string;
  currentValue: string;
  tokenRef: string;
  /** Layers actually bound, which is not always the whole batch. */
  count: number;
  failed: number;
  /** Coverage points the bind was worth, for the +x% on the receipt. */
  gain: number;
  /** Index the batch held in the queue, so the receipt lands where the row was. */
  index: number;
}

/**
 * Panel-local actions. They never leave the iframe — skipping a batch is a
 * statement about this queue, not an edit to the file — but they move the same
 * state as the sandbox's messages, so they go through the same reducer.
 */
export type PanelAction =
  /** Open one card, closing whichever was open. Null closes all. */
  | { type: "open-batch"; batchId: string | null }
  | { type: "pick-candidate"; batchId: string; tokenRef: string }
  | { type: "skip-batch"; batchId: string }
  | { type: "unskip-batch"; batchId: string };

export type PanelInput = PluginMessage | PanelAction;

export interface StudioState {
  booted: boolean;
  fileName: string;
  pageName: string;
  themes: ThemeChoice[];
  themeId: string;
  panelState: PanelState;
  report: LintReport | null;
  reconciliation: ReconciliationReport | null;
  /**
   * Coverage from the report before this one, so the panel can show which way the
   * number just moved. Editing a design makes it go both ways, and seeing "-0.4%"
   * the moment you add a hardcoded colour is the whole feedback loop.
   */
  previousPercent: number | null;
  /**
   * Coverage the first time this session measured it. The ring's third stat is
   * "session", and a delta against the previous report answers a different
   * question — it goes to zero the moment you look away and look back.
   */
  sessionBasePercent: number | null;
  nodeCount: number;
  status: string;
  busy: boolean;
  error: string | null;
  /**
   * Stays until dismissed or superseded — not a three-second toast. Somebody who
   * just changed 110 layers should not have to catch a message.
   */
  applied: AppliedPayload | null;
  heatmapOn: boolean;
  heatmapNodes: number;
  selectionCount: number;
  selectionName: string | null;
  /** Set only when a single CONTAINER is selected — i.e. something checkable. */
  selectionId: string | null;
  exportProgress: string;
  exportResult: ExportPayload | null;
  /** How the last walk was delivered. Null until the first export-done. */
  exportPublish: ExportPublish | null;
  user: ActivityActor | null;
  activity: ActivityEntry[];

  // --- the queue's own view state ---------------------------------------
  /** At most one card is expanded, always. */
  openBatchId: string | null;
  /** batchId -> the candidate token the designer selected. Never a default. */
  picks: Record<string, string>;
  /** Batch ids put aside for now. Panel-local; nothing was written. */
  skipped: string[];
  /** Binds that landed this session, each anchored where its row was. */
  resolved: ResolvedRow[];
}

export const initialState: StudioState = {
  booted: false,
  fileName: "",
  pageName: "",
  themes: [],
  themeId: "",
  panelState: "expanded",
  report: null,
  reconciliation: null,
  previousPercent: null,
  sessionBasePercent: null,
  nodeCount: 0,
  status: "Starting…",
  busy: true,
  error: null,
  applied: null,
  heatmapOn: false,
  heatmapNodes: 0,
  selectionCount: 0,
  selectionName: null,
  selectionId: null,
  exportProgress: "",
  exportResult: null,
  exportPublish: null,
  user: null,
  activity: [],
  openBatchId: null,
  picks: {},
  skipped: [],
  resolved: [],
};

export function reduce(state: StudioState, message: PanelInput): StudioState {
  switch (message.type) {
    // --- panel-local -----------------------------------------------------
    case "open-batch":
      return {
        ...state,
        openBatchId: state.openBatchId === message.batchId ? null : message.batchId,
      };

    case "pick-candidate":
      return { ...state, picks: { ...state.picks, [message.batchId]: message.tokenRef } };

    case "skip-batch":
      return {
        ...state,
        skipped: state.skipped.includes(message.batchId)
          ? state.skipped
          : [...state.skipped, message.batchId],
        openBatchId: state.openBatchId === message.batchId ? null : state.openBatchId,
      };

    case "unskip-batch":
      return { ...state, skipped: state.skipped.filter((id) => id !== message.batchId) };

    case "boot":
      return {
        ...state,
        booted: true,
        fileName: message.payload.fileName,
        pageName: message.payload.pageName,
        themes: message.payload.themes,
        themeId: message.payload.themeId,
        panelState: message.payload.panelState,
        user: message.payload.user,
      };

    case "status":
      return { ...state, status: message.message, busy: message.busy };

    case "report": {
      // A full re-lint is a fresh reading of the page — refresh, re-target, a
      // theme switch, an undo. Whatever the queue was holding about "not now"
      // and "just did that" describes a queue that no longer exists, so it goes.
      // An incremental re-lint is the tail of a bind and must keep both.
      const view =
        message.scope === "full"
          ? { openBatchId: null, picks: {}, skipped: [], resolved: [] }
          : pruneView(state, message.report);

      return {
        ...state,
        ...view,
        report: message.report,
        reconciliation: message.reconciliation,
        activity: message.activity,
        sessionBasePercent: state.sessionBasePercent ?? message.report.coverage.percent,
        // Only a real re-measurement counts as movement. A replayed report (the
        // `ui-ready` handshake posts the current one again) must not invent a
        // delta of zero-from-itself.
        previousPercent:
          state.report && state.report.coverage.percent !== message.report.coverage.percent
            ? state.report.coverage.percent
            : state.previousPercent,
        nodeCount: message.nodeCount,
        error: null,
        // A report means a lint finished, so it also clears `busy`. The sandbox
        // posts an authoritative status immediately after every report and that
        // is what actually governs — but `busy` starts true and gates every
        // button in the panel, so it must not be reachable only by a message
        // that can arrive before the iframe is listening. Belt and braces on the
        // one flag that can make the whole UI look broken.
        busy: false,
        status: "",
        // `applied` deliberately survives a new report. The status line stays
        // until a later fix supersedes it, because somebody who just changed 110
        // layers should not have to catch a toast.
      };
    }

    case "applied":
      return {
        ...state,
        applied: message.payload,
        error: null,
        // The row turns into its own receipt, right where it was. Recorded here
        // rather than on the next report because THIS is the last moment the
        // batch still exists: the re-lint that follows removes it.
        resolved: recordResolved(state, message.payload),
        skipped: state.skipped.filter((id) => id !== message.payload.batchId),
        openBatchId: state.openBatchId === message.payload.batchId ? null : state.openBatchId,
      };

    case "panel-state":
      // Authoritative: the sandbox posts this only after the window has actually
      // been resized, so the layout always matches the box it is drawn in.
      return { ...state, panelState: message.state };

    case "heatmap":
      return { ...state, heatmapOn: message.on, heatmapNodes: message.nodes };

    case "selection":
      return {
        ...state,
        selectionCount: message.count,
        selectionName: message.name,
        selectionId: message.id,
      };

    case "export-progress":
      return { ...state, exportProgress: message.message };

    case "export-done":
      return {
        ...state,
        exportProgress: "",
        exportResult: {
          jsonName: message.jsonName,
          json: message.json,
          screenshots: message.screenshots,
          summary: message.summary,
        },
        exportPublish: message.publish,
      };

    case "error":
      return { ...state, error: message.message, busy: false };
  }
  return state;
}

/**
 * Turn a landed apply into the receipt its own row will render.
 *
 * Only a batch the current report still knows about gets one — that is what
 * supplies the position to anchor to and the coverage it was worth. Autofix
 * deliberately does not qualify: it spans batches, has no single row to become,
 * and is followed by a full re-lint anyway. It lands on the status line instead,
 * which is where a multi-batch action belongs.
 */
function recordResolved(state: StudioState, payload: AppliedPayload): ResolvedRow[] {
  if (payload.applied <= 0) return state.resolved;
  const index = state.report?.batches.findIndex((batch) => batch.id === payload.batchId) ?? -1;
  if (index < 0) return state.resolved;
  const batch = state.report?.batches[index];
  if (!batch) return state.resolved;

  const row: ResolvedRow = {
    batchId: payload.batchId,
    label: batch.label,
    currentValue: batch.currentValue,
    tokenRef: payload.tokenRef,
    count: payload.applied,
    failed: payload.failed,
    gain: batch.coverageGain,
    index,
  };
  return [...state.resolved.filter((item) => item.batchId !== row.batchId), row];
}

/**
 * Carry the queue's view state across an incremental re-lint.
 *
 * Anything naming a batch that is no longer loose is dropped — except the
 * receipts, which exist precisely because their batch is gone. A receipt whose
 * batch came BACK is the one to drop: the value is loose again, so the row has
 * to go back to being a row.
 */
function pruneView(
  state: StudioState,
  report: LintReport,
): Pick<StudioState, "openBatchId" | "picks" | "skipped" | "resolved"> {
  const live = new Set(report.batches.map((batch) => batch.id));
  const picks: Record<string, string> = {};
  for (const [batchId, tokenRef] of Object.entries(state.picks)) {
    if (live.has(batchId)) picks[batchId] = tokenRef;
  }
  return {
    openBatchId: state.openBatchId && live.has(state.openBatchId) ? state.openBatchId : null,
    picks,
    skipped: state.skipped.filter((id) => live.has(id)),
    resolved: state.resolved.filter((row) => !live.has(row.batchId)),
  };
}
