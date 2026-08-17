/**
 * The sandbox <-> iframe message contract.
 *
 * Both sides import this file, so a message the UI sends and a message the
 * sandbox handles cannot drift apart without the compiler saying so.
 *
 * Everything crossing the boundary is structured-clonable: no Maps, no
 * functions, no class instances. `LintReport` was designed for that.
 */
import type { AssetPlacement, TargetMatch, TargetOption } from "./assets.js";
import type { AssetBinding, AssetFit } from "./ir/schema.js";
import type { PreviewSummary } from "./api/types.js";
import type { ActivityActor, ActivityEntry } from "./health/activity.js";
import type { LintReport } from "./health/types.js";
import type { ReconciliationReport } from "./health/reconcile-report.js";
import type { ThemeChoice } from "./themes.js";

export type { ActivityActor, ActivityEntry };

export type PanelState = "expanded" | "collapsed";
export type Tab = "health" | "assets" | "preview" | "export";

export const PANEL_SIZES: Record<PanelState, { width: number; height: number }> = {
  expanded: { width: 448, height: 720 },
  collapsed: { width: 280, height: 44 },
};

export const CLIENT_STORAGE_KEY = "fanos-studio.panel-state";
export const CLIENT_STORAGE_THEME_KEY = "fanos-studio.theme-id";
/** Origin Surface Studio is listening on. Must be on the api allowlist. */
export const CLIENT_STORAGE_API_ORIGIN_KEY = "fanos-studio.api-origin";

// ---------------------------------------------------------------------------
// UI -> sandbox
// ---------------------------------------------------------------------------

export type UiMessage =
  | { type: "ui-ready" }
  /**
   * Full re-lint of the frame already being checked. Deliberately does NOT
   * re-target: "Select layers" and any stray canvas click change the selection,
   * and a refresh that quietly followed it would keep moving the ground under
   * someone who just wanted their numbers updated.
   */
  | { type: "refresh" }
  /** Re-target onto the current selection. The only way the checked frame moves. */
  | { type: "retarget" }
  | { type: "select-theme"; themeId: string }
  | { type: "select-batch"; batchId: string }
  | { type: "apply-batch"; batchId: string }
  /**
   * Apply every safe batch at once, as ONE undo step. Not a loop over
   * `apply-batch` — that produced one undo entry per batch, so taking back an
   * autofix meant pressing Ctrl-Z as many times as there happened to be batches.
   */
  | { type: "autofix" }
  /** F7 — write whole-pixel values for one batch. Not a token bind. */
  | { type: "apply-round"; batchId: string }
  /** B1 / B2. */
  | { type: "apply-structural"; action: "wrap-autolayout" | "convert-groups" }
  /**
   * Rewrite drifted local variables to the theme's values. Never library
   * variables — those are not ours to change.
   */
  | { type: "reset-drift"; refs?: string[] }
  | { type: "select-nodes"; nodeIds: string[] }
  /**
   * Set pinned text to hug height (textAutoResize HEIGHT). Live copy can then
   * grow the box. Omit nodeIds to hug every pinned text layer in the report.
   */
  | { type: "hug-text"; nodeIds?: string[] }
  /**
   * Create the Figma variables the queue is blocked on. Omit `refs` for every
   * token an exact batch wants and this file does not have.
   */
  | { type: "create-variables"; refs?: string[] }
  /** A near batch, after the designer picked one of the candidate swatches. */
  | { type: "apply-candidate"; batchId: string; tokenRef: string }
  | { type: "undo-last" }
  | { type: "dismiss-undo" }
  | { type: "toggle-heatmap"; on: boolean }
  | { type: "set-panel-state"; state: PanelState }
  /**
   * An image the designer exported from Figma and dropped in.
   *
   * The bytes are registered with the Figma document and the region they came
   * from is inferred from the filename and the pixel size — see
   * `ir/match-asset.ts`. `targetId` is only set when the designer is answering
   * a question the matcher could not.
   */
  | {
      type: "upload-asset";
      fileName: string;
      bytes: Uint8Array;
      width: number;
      height: number;
      targetId?: string;
    }
  /**
   * Place an image already registered with the document.
   *
   * The answer to the "which element is this?" prompt. The bytes went in when
   * the file was dropped, so answering must not re-upload them — passing empty
   * bytes back through `upload-asset` would ask Figma to create a second image
   * from nothing.
   */
  | {
      type: "place-asset";
      imageHash: string;
      fileName: string;
      width: number;
      height: number;
      targetId: string;
    }
  /** Point an existing asset at a different element. */
  | { type: "retarget-asset"; key: string; targetId: string }
  | { type: "remove-asset"; key: string }
  /**
   * Rename the asset. This is `asset.texture.<name>` — a token the compiler
   * emits and a run persists a URL against — so the sandbox validates it and
   * refuses a collision rather than writing it through.
   */
  | { type: "rename-asset"; key: string; name: string }
  /** Override how the bitmap fills its box. */
  | { type: "set-asset-fit"; key: string; fit: AssetFit }
  /**
   * Compile the checked frame and render it, via Surface Studio.
   *
   * On demand, never on every edit: it walks the frame, exports the marked
   * assets and round-trips a whole page. What it buys is the answer the panel
   * could not previously give at all — what this frame actually looks like once
   * compiled — without an export, a run and a gate in between.
   */
  | { type: "preview-compile" }
  /** Walk the frame and keep the result for a local ZIP. The escape hatch. */
  | { type: "export-ir" }
  /**
   * Walk the frame and POST it to Surface Studio. Same files as the ZIP.
   * The local result is still posted so Save ZIP works if the board is down.
   */
  | { type: "publish-export" }
  | { type: "close" };

// ---------------------------------------------------------------------------
// sandbox -> UI
// ---------------------------------------------------------------------------

export interface BootPayload {
  fileName: string;
  pageName: string;
  themes: ThemeChoice[];
  themeId: string;
  panelState: PanelState;
  user: ActivityActor;
}

export interface AppliedPayload {
  batchId: string;
  label: string;
  tokenRef: string;
  applied: number;
  failed: number;
  /** First few failures, so the panel can say what went wrong and not just how many. */
  failures: string[];
  /** True while the fix is still the top of the undo stack. */
  undoable: boolean;
  /** Who ran this apply. Undo is only this session — never someone else's bind. */
  user: ActivityActor;
}

export type PluginMessage =
  | { type: "boot"; payload: BootPayload }
  | { type: "status"; message: string; busy: boolean }
  | {
      type: "report";
      report: LintReport;
      reconciliation: ReconciliationReport;
      activity: ActivityEntry[];
      scope: "full" | "incremental";
      nodeCount: number;
    }
  | { type: "applied"; payload: AppliedPayload }
  /**
   * The authoritative panel state, posted after the window has actually been
   * resized. The UI never changes its own layout on a click — it waits for this
   * — so the window size and the layout drawn inside it cannot disagree.
   */
  | { type: "panel-state"; state: PanelState }
  | { type: "heatmap"; on: boolean; nodes: number }
  | {
      type: "selection";
      count: number;
      name: string | null;
      id: string | null;
      /** Any single selected node — image layers included. */
      nodeId: string | null;
      hasImage: boolean;
      parentId: string | null;
      parentName: string | null;
    }
  | {
      type: "assets";
      bindings: AssetBinding[];
      /** Keyed by image hash. Where each asset lands inside what it paints. */
      placements: Record<string, AssetPlacement>;
      /** Keyed by image hash. The elements each asset could be re-pointed at. */
      targets: Record<string, TargetOption[]>;
    }
  /**
   * A dropped image the matcher could not place with confidence.
   *
   * Carries the candidates rather than picking one. A background painted onto
   * the wrong element is harder to notice, and harder to diagnose, than one
   * that was never placed — so an uncertain match asks instead of guessing.
   * The bytes are already in the document; only the target is outstanding.
   */
  | {
      type: "asset-unmapped";
      fileName: string;
      imageHash: string;
      width: number;
      height: number;
      candidates: TargetMatch[];
    }
  | { type: "export-progress"; message: string }
  | {
      type: "export-done";
      jsonName: string;
      json: string;
      screenshots: Array<{ name: string; nodeId: string; bytes: Uint8Array }>;
      assets: Array<{
        name: string;
        nodeId: string;
        targetNodeId: string;
        role: "background";
        bytes: Uint8Array;
        /** `rendered` means the original bitmap was unreachable — see export.ts. */
        source: "original" | "rendered";
      }>;
      summary: Record<string, unknown>;
      /**
       * How the walk left the building. `local` is the ZIP-only escape hatch.
       * A failed publish still carries the files so Save ZIP is the way out.
       */
      publish: ExportPublish;
    }
  | { type: "preview-progress"; message: string }
  | {
      type: "preview-done";
      /** A complete HTML document, or null when the compile failed. */
      html: string | null;
      width: number;
      summary: PreviewSummary | null;
      /** Why there are no pixels. Null on success. */
      error: string | null;
    }
  | { type: "error"; message: string };

export type ExportPublish =
  | { kind: "local" }
  | { kind: "sent"; origin: string }
  | { kind: "failed"; origin: string; message: string };
