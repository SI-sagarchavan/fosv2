/**
 * FanOS Surface Canvas — sandbox entry. FIGMA-AWARE.
 *
 * Owns the session: which frame is being checked, which theme it is checked
 * against, the reconciled binding index, the last report, and the heatmap. Every
 * decision about *what is wrong* lives in the pure engine under src/health/;
 * this file only reads Figma, writes Figma, and posts messages.
 *
 * Performance shape, because the sandbox is single-threaded and blocking it
 * freezes the canvas:
 *
 *   - traversal yields to the event loop every 500 nodes
 *   - `nodechange` on the current page is debounced 400ms
 *   - a change re-walks only the subtrees named in the event, then re-runs the
 *     pure pass over the patched tree. Full re-walk only on explicit refresh.
 *   - variables and styles are resolved once per session into Maps
 */
import { inferBreakpoint } from "./match/type.js";
import {
  ACTIVITY_PREFIX,
  appendLane,
  laneKey,
  mergeActivity,
  parseLane,
  popLane,
  type ActivityActor,
  type ActivityEntry,
  type ActivityKind,
} from "./health/activity.js";
import { reconciliationReport } from "./health/reconcile-report.js";
import { invalidateSlots } from "./health/slots.js";
import type { Batch, BatchItem, LintOptions, LintReport, ThemeSnapshot } from "./health/types.js";
import { DEFAULT_LINT_OPTIONS, isFixProposal, isRoundProposal } from "./health/types.js";
import type { FrameIRDocument, FrameIRNode } from "./ir/schema";
import { lint } from "./rules/index.js";
import {
  applyAll,
  applyBatch,
  applyCandidate,
  applyRound,
  convertGroupsToFrames,
  hugText,
  undoLastBatch,
  wrapAsColumn,
  type ApplyOptions,
  type ApplyOutcome,
} from "./fix.js";
import * as heatmap from "./heatmap.js";
import { loadBindingIndex, reconcile, type BindingIndex } from "./reconcile.js";
import {
  ASSET_PLUGIN_KEY,
  isConfident,
  matchAssetToTargets,
  parseBindings,
  placementsFromIr,
  removeBinding,
  renameBinding,
  retargetBinding,
  serializeBindings,
  setBindingFit,
  suggestAssetName,
  targetOptionsFromIr,
  upsertBinding,
  type AssetBinding,
  type AssetFit,
} from "./assets.js";
import { runExport } from "./export.js";
import { createMissingVariables, resetDriftedVariables } from "./variables.js";
import { defaultTheme, rawThemeFileFor, themeById, themeChoices } from "./themes.js";
import {
  buildExportBody,
  bytesToBase64,
  createApiClient,
  resolveOrigin,
  type ApiClient,
  type ApiFetch,
  type ApiFetchInit,
  type StudioPage,
} from "./api/index.js";
import {
  CLIENT_STORAGE_API_ORIGIN_KEY,
  CLIENT_STORAGE_KEY,
  CLIENT_STORAGE_THEME_KEY,
  PANEL_SIZES,
  type AppliedPayload,
  type ExportPublish,
  type PanelState,
  type PluginMessage,
  type UiMessage,
} from "./protocol.js";
import {
  errorMessage,
  newCaches,
  traverseSubtree,
  traverseToDocument,
  yieldToEventLoop,
  type Caches,
} from "./traverse";

const NODE_CHANGE_DEBOUNCE_MS = 400;
/**
 * Our own writes come back as change events and we cannot tell them apart from
 * the designer's. So changes are ignored for a moment after a fix — which we
 * re-lint ourselves anyway, on just the subtrees we touched.
 */
const SELF_WRITE_QUIET_MS = 700;

interface State {
  booted: boolean;
  caches: Caches;
  index: BindingIndex | null;
  snapshot: ThemeSnapshot | null;
  themeId: string;
  root: SceneNode | null;
  /** The pinned frame. Survives selection changes; only "Check selection" moves it. */
  rootId: string | null;
  ir: FrameIRDocument | null;
  report: LintReport | null;
  heatmapOn: boolean;
  panelState: PanelState;
  options: LintOptions;
  busy: boolean;
  quietUntil: number;
  lastActivityId: string | null;
  /** Outbound Surface Studio client. Never blocks a lint. */
  api: ApiClient | null;
}

const state: State = {
  booted: false,
  caches: newCaches(),
  index: null,
  snapshot: null,
  themeId: "",
  root: null,
  rootId: null,
  ir: null,
  report: null,
  heatmapOn: false,
  panelState: "expanded",
  options: DEFAULT_LINT_OPTIONS,
  busy: false,
  quietUntil: 0,
  lastActivityId: null,
  api: null,
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * The message handler is installed SYNCHRONOUSLY, before any await.
 *
 * The iframe posts `ui-ready` as soon as React mounts, and that can easily land
 * before an `await figma.clientStorage.getAsync(...)` further down has resolved.
 * A handler installed after the first await misses it, and since `ui-ready` is
 * what triggers the boot payload, missing it once leaves the panel showing its
 * initial state forever — empty theme picker, "Starting…" that never moves.
 */
figma.ui.onmessage = (message: UiMessage) => {
  void handle(message).catch((err) => fail(errorMessage(err)));
};

// `void boot()` on its own swallows a rejection into an unhandled promise and the
// panel just sits there. Anything that goes wrong in here has to reach the UI.
void boot().catch((err) => fail(`Couldn't start: ${errorMessage(err)}`));

async function boot(): Promise<void> {
  state.panelState = await readPanelState();
  const size = PANEL_SIZES[state.panelState];

  figma.showUI(__html__, { width: size.width, height: size.height, themeColors: true });
  // Applied again on `ui-ready` — see the note there. Once is not enough.
  applyPanelSize(state.panelState);

  heatmap.registerCleanup();
  heatmap.clearStaleOverlays();

  const storedTheme = await readStoredTheme();
  const theme = (storedTheme && themeById(storedTheme)) || defaultTheme();
  state.themeId = theme.id;

  const origin = resolveOrigin(await readStoredApiOrigin());
  state.api = createApiClient({ origin, fetch: sandboxFetch });
  console.log(`[fanos-studio] api origin ${origin}`);

  state.booted = true;
  // Sent unconditionally AND replayed on every `ui-ready`. Whichever side wins
  // the race, the panel ends up with the payload.
  postBoot();

  figma.on("selectionchange", postSelection);
  // `figma.on("documentchange")` is unavailable under `documentAccess:
  // dynamic-page` without calling `loadAllPagesAsync()` first, which on a real
  // file means loading every page before the panel can do anything. The page-
  // scoped `nodechange` event is what we actually want anyway: this plugin only
  // ever lints the current page.
  watchCurrentPage();
  // The listener above is bound to one page, so switching pages has to re-bind
  // it and re-lint. Otherwise the panel keeps showing a confident report about a
  // page the designer has left.
  figma.on("currentpagechange", () => {
    watchCurrentPage();
    // A new page needs a new root; the pinned one lives on the old one.
    state.rootId = null;
    void fullLint(true);
  });
  postSelection();

  await fullLint();
}

let unwatchPage: (() => void) | undefined;

function watchCurrentPage(): void {
  unwatchPage?.();
  const page = figma.currentPage;
  page.on("nodechange", onNodeChange);
  unwatchPage = () => page.off("nodechange", onNodeChange);
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handle(message: UiMessage): Promise<void> {
  switch (message.type) {
    case "ui-ready":
      // Replay everything the panel needs, in the order it needs it. The iframe
      // re-sends `ui-ready` if it hasn't heard back, so this has to be safe to
      // run more than once — it is: all three are plain re-posts of current state.
      if (state.booted) postBoot();
      // Re-apply the window size now that the iframe genuinely exists. Figma
      // restores the size the user last dragged this plugin to, and that restore
      // can land AFTER the `showUI` call — clobbering a size set in the same
      // tick. Doing it again here is what makes the collapsed state stick.
      applyPanelSize(state.panelState);
      postSelection();
      if (state.report) postReport(state.report, "full");
      // ALWAYS, not just when there is no report. `busy` starts true in the
      // panel and is only ever cleared by a status message, so a run that
      // finished before the iframe was listening would otherwise leave it stuck
      // on "Starting…" with every button disabled — with a perfectly good
      // report already on screen.
      status(state.busy ? "Reading the page…" : "", state.busy);
      return;
    case "refresh":
      // An explicit refresh re-reads EVERYTHING, variables included. Somebody who
      // just created the missing variables the reconciliation report asked for
      // needs this to pick them up — the index is cached for the session
      // otherwise, and the batches would stay disabled with no way to fix it.
      state.index = null;
      await fullLint();
      return;
    case "retarget":
      await fullLint(true);
      return;
    case "select-theme":
      await selectTheme(message.themeId);
      return;
    case "select-batch":
      selectBatchLayers(message.batchId);
      return;
    case "apply-batch":
      await applyBatchById(message.batchId, null);
      return;
    case "autofix":
      await runAutofix();
      return;
    case "apply-round":
      await applyRoundById(message.batchId);
      return;
    case "apply-structural":
      await applyStructural(message.action);
      return;
    case "reset-drift":
      await resetDrift(message.refs);
      return;
    case "select-nodes":
      await selectNodes(message.nodeIds);
      return;
    case "hug-text":
      await hugPinnedText(message.nodeIds);
      return;
    case "create-variables":
      await createVariables(message.refs);
      return;
    case "apply-candidate":
      await applyBatchById(message.batchId, message.tokenRef);
      return;
    case "undo-last":
      undoLastBatch();
      if (state.root) retractActivity(state.root, state.lastActivityId);
      state.lastActivityId = null;
      state.quietUntil = Date.now() + SELF_WRITE_QUIET_MS;
      await fullLint();
      return;
    case "dismiss-undo":
      return;
    case "toggle-heatmap":
      toggleHeatmap(message.on);
      return;
    case "set-panel-state":
      await setPanelState(message.state);
      return;
    case "upload-asset":
      await uploadAsset(message);
      return;
    case "place-asset":
      await placeAsset(message);
      return;
    case "retarget-asset":
      await retargetAsset(message.key, message.targetId);
      return;
    case "remove-asset":
      removeAsset(message.key);
      return;
    case "rename-asset":
      renameAsset(message.key, message.name);
      return;
    case "set-asset-fit":
      setAssetFit(message.key, message.fit);
      return;
    case "preview-compile":
      await previewCompile();
      return;
    case "export-ir":
      await exportIr("local");
      return;
    case "publish-export":
      await exportIr("publish");
      return;
    case "close":
      figma.closePlugin();
      return;
  }
}

// ---------------------------------------------------------------------------
// Linting
// ---------------------------------------------------------------------------

async function fullLint(repick = false): Promise<void> {
  const root = await resolveRoot(repick);
  if (!root) {
    fail("This page has no frame to check. Add a frame, or select the one you want checked.");
    return;
  }
  state.root = root;
  await busy(async () => {
    // Walk FIRST. The traversal's id->name cache ends up holding every variable
    // the page is already bound to, and on a library-driven file those are the
    // only real Variable objects there are — `getLocalVariableCollectionsAsync`
    // returns nothing at all. Reconciling before the walk means reconciling
    // against an empty file.
    status("Walking the page…");
    const { document } = await traverseToDocument(root, state.caches, (message, nodes) =>
      status(nodes > 0 ? `${message}` : message),
    );
    state.ir = document;

    status("Reading variables…");
    if (!state.index) state.index = await loadBindingIndex(state.caches.variables.keys());

    const theme = themeById(state.themeId) ?? defaultTheme();
    status(`Reconciling ${theme.name}…`);
    state.snapshot = await reconcile(theme, state.index);

    status("Linting…");
    runLint("full");
    if (state.heatmapOn && state.ir) heatmap.draw(state.ir);
  });
}

function runLint(scope: "full" | "incremental"): void {
  if (!state.ir || !state.snapshot) return;
  // An incremental re-lint patches subtrees in place under the SAME root object,
  // which would otherwise hit the memoized slot walk and report the score from
  // before the edit. Dropping it here means every lint sees the tree as it is.
  invalidateSlots(state.ir.root);
  const started = Date.now();
  const report = lint(
    state.ir,
    {
      theme: state.snapshot,
      breakpoint: inferBreakpoint(state.ir.breakpointHint),
      options: state.options,
    },
    started,
  );
  state.report = report;
  postReport(report, scope);
  postAssets();
}

function postBoot(): void {
  post({
    type: "boot",
    payload: {
      fileName: figma.root.name,
      pageName: figma.currentPage.name,
      themes: themeChoices(),
      themeId: state.themeId,
      panelState: state.panelState,
      user: currentActor(),
    },
  });
  postAssets();
}

function postReport(report: LintReport, scope: "full" | "incremental"): void {
  if (!state.snapshot) return;
  post({
    type: "report",
    report,
    reconciliation: reconciliationReport(state.snapshot),
    activity: state.root ? readActivity(state.root) : [],
    scope,
    nodeCount: state.ir ? heatmap.nodeCountFor(state.ir.root) : 0,
  });
  // A report is a fact; `busy` is a fact about the sandbox. They travel together
  // so the panel can never end up holding one without the other.
  post({ type: "status", message: state.busy ? "Linting…" : "", busy: state.busy });
}

/**
 * The frame being checked, which STAYS the frame being checked.
 *
 * Once resolved it is pinned to `state.rootId` and every later lint re-reads
 * that same node. Re-targeting happens in exactly two places: an explicit
 * "Check selection" from the panel, and a page change. Nothing else moves it —
 * least of all a refresh, which used to re-derive the root from whatever
 * happened to be selected and so followed "Select layers" onto a single card.
 */
async function resolveRoot(repick: boolean): Promise<SceneNode | null> {
  if (!repick && state.rootId) {
    const pinned = await figma.getNodeByIdAsync(state.rootId);
    // Still alive, still on this page, still something we can walk.
    if (
      pinned &&
      !(pinned as SceneNode).removed &&
      "children" in pinned &&
      isOnCurrentPage(pinned as SceneNode)
    ) {
      return pinned as SceneNode;
    }
  }

  const picked = pickRoot();
  state.rootId = picked?.id ?? null;
  return picked;
}

function isOnCurrentPage(node: SceneNode): boolean {
  let current: BaseNode | null = node;
  while (current) {
    if (current.id === figma.currentPage.id) return true;
    current = current.parent;
  }
  return false;
}

/**
 * A selected container wins — that is what "Check selection" means. Otherwise
 * the page's biggest top-level container, which on a real page is the design.
 */
function pickRoot(): SceneNode | null {
  const selection = figma.currentPage.selection;
  if (selection.length === 1 && "children" in selection[0]!) return selection[0]!;

  const candidates = figma.currentPage.children.filter(
    (node) => node.visible !== false && node.name !== heatmap.HEATMAP_FRAME_NAME,
  );
  if (candidates.length === 0) return null;

  // Containers first, then biggest. Area alone picks a full-bleed background
  // image over the layout sitting next to it — a node with nothing bindable
  // inside it, which reads in the panel as a page with 0% coverage.
  const containers = candidates.filter(
    (node) => "children" in node && (node as ChildrenMixin).children.length > 0,
  );
  const pool = containers.length > 0 ? containers : candidates;

  let best = pool[0]!;
  let bestArea = area(best);
  for (const node of pool.slice(1)) {
    const a = area(node);
    if (a > bestArea) {
      best = node;
      bestArea = a;
    }
  }
  return best;
}

function area(node: SceneNode): number {
  const box = "absoluteBoundingBox" in node ? node.absoluteBoundingBox : null;
  return (box?.width ?? 0) * (box?.height ?? 0);
}

// ---------------------------------------------------------------------------
// Incremental re-lint
// ---------------------------------------------------------------------------

let pendingChanges = new Set<string>();
let debounceTimer: number | undefined;

function onNodeChange(event: NodeChangeEvent): void {
  // Only our own writes are ignored, and only briefly — we re-lint those
  // ourselves, on just the subtrees we touched. Everything the designer does is
  // collected, even mid-lint, so an edit made while Studio is working is not
  // silently dropped.
  if (Date.now() < state.quietUntil) return;
  for (const change of event.nodeChanges) pendingChanges.add(change.id);
  scheduleRelint();
}

function scheduleRelint(): void {
  if (debounceTimer !== undefined) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    // Mid-lint: leave the ids queued and come back rather than running two
    // traversals over the same tree.
    if (state.busy) {
      scheduleRelint();
      return;
    }
    const ids = [...pendingChanges];
    pendingChanges = new Set();
    void relint(ids).catch((err) => fail(errorMessage(err)));
  }, NODE_CHANGE_DEBOUNCE_MS);
}

interface IrLocation {
  node: FrameIRNode;
  parent: FrameIRNode | null;
  index: number;
}

function indexIr(root: FrameIRNode): Map<string, IrLocation> {
  const map = new Map<string, IrLocation>();
  const stack: Array<{ node: FrameIRNode; parent: FrameIRNode | null; index: number }> = [
    { node: root, parent: null, index: -1 },
  ];
  while (stack.length > 0) {
    const item = stack.pop()!;
    map.set(item.node.id, { node: item.node, parent: item.parent, index: item.index });
    for (let i = item.node.children.length - 1; i >= 0; i--) {
      stack.push({ node: item.node.children[i]!, parent: item.node, index: i });
    }
  }
  return map;
}

/**
 * Re-walks only the subtrees that changed, then re-runs the pure pass over the
 * patched tree.
 *
 * The pure pass is cheap and whole-page rules (the blockers, the naming warn)
 * need the whole tree anyway, so the saving that matters is the Figma reads —
 * which is where all the time goes.
 */
async function relint(changedIds: string[]): Promise<void> {
  if (!state.ir || changedIds.length === 0) return;

  const located = indexIr(state.ir.root);
  const roots = new Set<string>();
  for (const id of changedIds) {
    const anchor = await anchorFor(id, located);
    if (anchor === "full") {
      await fullLint();
      return;
    }
    if (anchor) roots.add(anchor);
  }
  if (roots.size === 0) return;

  await busy(async () => {
    for (const id of roots) {
      const location = located.get(id);
      if (!location) continue;
      const node = await figma.getNodeByIdAsync(id);
      if (!node || (node as SceneNode).removed) {
        if (location.parent) location.parent.children.splice(location.index, 1);
        continue;
      }
      const fresh = await traverseSubtree(node as SceneNode, location.node.depth, state.caches);
      if (location.parent) location.parent.children[location.index] = fresh;
      else if (state.ir) state.ir = { ...state.ir, root: fresh };
    }
    runLint("incremental");
    if (state.heatmapOn && state.ir) heatmap.draw(state.ir);
  });
}

/**
 * The nearest ancestor of a changed node that the cached IR knows about.
 *
 * A brand-new layer is not in the tree, but its parent is; re-walking the parent
 * picks it up. Nothing on the path being known means the change was outside the
 * frame we are checking, or the tree moved under us — the caller falls back to a
 * full pass.
 */
async function anchorFor(
  id: string,
  located: Map<string, IrLocation>,
): Promise<string | "full" | null> {
  if (located.has(id)) return id;

  const node = await figma.getNodeByIdAsync(id);
  if (!node) return null;

  let current: BaseNode | null = (node as SceneNode).parent ?? null;
  for (let hops = 0; current && hops < 64; hops++) {
    if (located.has(current.id)) return current.id;
    current = current.parent;
  }
  // Outside the checked frame entirely — a change on another page or another
  // top-level frame. Nothing to do.
  return null;
}

// ---------------------------------------------------------------------------
// Fixes
// ---------------------------------------------------------------------------

async function applyBatchById(batchId: string, tokenRef: string | null): Promise<void> {
  const batch = state.report?.batches.find((b) => b.id === batchId);
  if (!batch) {
    fail("That batch is from an older report. Refresh and try again.");
    return;
  }
  const proposal = batch.proposal;
  if (!proposal || !isFixProposal(proposal)) {
    fail(`${batch.label} has no fix to apply.`);
    return;
  }

  const ref = tokenRef ?? proposal.tokenRef;
  const binding = bindingFor(ref);
  if (!binding) {
    fail(`${ref} has nothing behind it in this file.`);
    return;
  }
  const index = state.index;
  if (!index) {
    fail("Variables haven't been read yet. Refresh and try again.");
    return;
  }

  await busy(async () => {
    status(`Binding ${batch.count} ${batch.count === 1 ? "layer" : "layers"} to ${ref}…`);
    const expected = expectedValueFor(ref);
    const outcome: ApplyOutcome =
      tokenRef === null
        ? await applyBatch({ batch, tokenRef: ref, binding, index, ...(expected ? { expected } : {}) })
        : await applyCandidate({ batch, tokenRef: ref, binding, index, ...(expected ? { expected } : {}) });

    state.quietUntil = Date.now() + SELF_WRITE_QUIET_MS;
    figma.notify(
      outcome.applied === 0 && outcome.failed > 0
        ? "Already bound on this frame — someone else may have got there first."
        : outcome.failed > 0
          ? `Bound ${outcome.applied} of ${batch.count} — ${outcome.failed} failed.`
          : `Bound ${outcome.applied} ${outcome.applied === 1 ? "layer" : "layers"} to ${ref}. One undo reverts all of it.`,
    );

    postApplied(
      {
        batchId: batch.id,
        label: batch.label,
        tokenRef: ref,
        applied: outcome.applied,
        failed: outcome.failed,
        failures: outcome.failures,
        undoable: outcome.applied > 0,
      },
      "bind",
    );

    // Re-lint the affected subtrees only, per the spec — not the whole page.
    await relintAffected(batch);
  });
}

async function applyRoundById(batchId: string): Promise<void> {
  const batch = state.report?.batches.find((item) => item.id === batchId);
  if (!batch) {
    fail("That batch is from an older report. Refresh and try again.");
    return;
  }
  const proposal = batch.proposal;
  if (!proposal || !isRoundProposal(proposal)) {
    fail(`${batch.label} isn't a value to round.`);
    return;
  }

  await busy(async () => {
    status(`Rounding ${batch.count} ${batch.count === 1 ? "value" : "values"}…`);
    const outcome = await applyRound(batch);
    state.quietUntil = Date.now() + SELF_WRITE_QUIET_MS;
    figma.notify(
      outcome.failed > 0
        ? `Rounded ${outcome.applied} of ${batch.count} — ${outcome.failed} failed.`
        : `Rounded ${outcome.applied} ${outcome.applied === 1 ? "value" : "values"} to ${proposal.roundedTo}. One undo reverts all of it.`,
    );
    postApplied({
      batchId: batch.id,
      label: `Rounded to ${proposal.roundedTo}`,
      tokenRef: "round",
      applied: outcome.applied,
      failed: outcome.failed,
      failures: outcome.failures,
      undoable: outcome.applied > 0,
    });
    await relintAffected(batch);
  });
}

async function applyStructural(action: "wrap-autolayout" | "convert-groups"): Promise<void> {
  const report = state.report;
  if (!report) {
    fail("Nothing has been checked yet.");
    return;
  }
  const planned = report.actions.find((item) => item.id === action);
  if (!planned) {
    fail("That fix is from an older report. Refresh and try again.");
    return;
  }

  await busy(async () => {
    status(action === "wrap-autolayout" ? "Stacking as a column…" : "Turning groups into frames…");
    const outcome =
      action === "wrap-autolayout"
        ? await wrapAsColumn(planned.nodeIds[0] ?? report.rootNodeId)
        : await convertGroupsToFrames(planned.nodeIds);
    state.quietUntil = Date.now() + SELF_WRITE_QUIET_MS;
    state.index = null;
    figma.notify(
      outcome.failed > 0
        ? `${planned.label}: ${outcome.applied} done, ${outcome.failed} failed.`
        : `${planned.label}. One undo reverts it.`,
    );
    postApplied({
      batchId: action,
      label: planned.label,
      tokenRef: action,
      applied: outcome.applied,
      failed: outcome.failed,
      failures: outcome.failures,
      undoable: outcome.applied > 0,
    });
    await fullLint();
  });
}

async function resetDrift(requested?: string[]): Promise<void> {
  const snapshot = state.snapshot;
  const index = state.index;
  if (!snapshot || !index) {
    fail("Nothing has been checked yet.");
    return;
  }
  const refs =
    requested && requested.length > 0
      ? requested
      : [
          ...snapshot.colors,
          ...snapshot.spaces,
          ...snapshot.radii,
        ]
          .filter((entry) => entry.binding?.valueMatches === false)
          .map((entry) => entry.ref);
  if (refs.length === 0) {
    figma.notify("No drifted variables to reset.");
    return;
  }

  await busy(async () => {
    status(`Resetting ${refs.length} ${refs.length === 1 ? "variable" : "variables"}…`);
    const result = await resetDriftedVariables(refs, snapshot, index);
    state.quietUntil = Date.now() + SELF_WRITE_QUIET_MS;
    figma.notify(
      result.created.length === 0
        ? `Nothing reset — ${result.skipped[0]?.reason ?? "nothing to do"}.`
        : `Reset ${result.created.length} ${result.created.length === 1 ? "variable" : "variables"} to the theme. One undo reverts them.`,
    );
    postApplied({
      batchId: "reset-drift",
      label: "Reset to theme",
      tokenRef: result.created.map((entry) => entry.figmaName).join(", ") || "none",
      applied: result.created.length,
      failed: result.skipped.length,
      failures: result.skipped.map((entry) => `${entry.ref}: ${entry.reason}`).slice(0, 5),
      undoable: result.created.length > 0,
    });
    state.index = null;
    await fullLint();
  });
}

async function hugPinnedText(requested?: string[]): Promise<void> {
  const ids =
    requested && requested.length > 0
      ? requested
      : (state.report?.sizing.pinnedText.map((item) => item.nodeId) ?? []);
  if (ids.length === 0) {
    figma.notify("No pinned text to hug.");
    return;
  }

  await busy(async () => {
    status(`Hugging ${ids.length} ${ids.length === 1 ? "text layer" : "text layers"}…`);
    const outcome = await hugText(ids);
    state.quietUntil = Date.now() + SELF_WRITE_QUIET_MS;
    figma.notify(
      outcome.failed > 0
        ? `Hugged ${outcome.applied} of ${ids.length} — ${outcome.failed} failed.`
        : `Hugged ${outcome.applied} ${outcome.applied === 1 ? "text layer" : "text layers"}. Copy can grow the box. One undo reverts.`,
    );
    postApplied({
      batchId: "hug-text",
      label: "Hug height",
      tokenRef: "textAutoResize",
      applied: outcome.applied,
      failed: outcome.failed,
      failures: outcome.failures,
      undoable: outcome.applied > 0,
    });
    await fullLint();
  });
}

async function selectNodes(ids: readonly string[]): Promise<void> {
  const nodes: SceneNode[] = [];
  for (const id of ids) {
    const node = await figma.getNodeByIdAsync(id);
    if (node && !(node as SceneNode).removed) nodes.push(node as SceneNode);
  }
  if (nodes.length === 0) {
    figma.notify("Those layers are gone. Refresh the report.");
    return;
  }
  figma.currentPage.selection = nodes;
  figma.viewport.scrollAndZoomIntoView(nodes);
}

/**
 * The tokens an exact batch wants and this file does not have.
 *
 * Deliberately only these: the queue's actual blockers, never the whole theme.
 * Unlocking four batches is not a licence to add 252 variables to somebody's
 * file.
 */
function missingTokenRefs(): string[] {
  const report = state.report;
  if (!report) return [];
  const refs = new Set<string>();
  for (const batch of report.batches) {
    const proposal = batch.proposal;
    if (!proposal || !isFixProposal(proposal)) continue;
    if (proposal.bindable) continue;
    if (proposal.kind !== "exact" && proposal.kind !== "near") continue;
    // Only genuinely absent ones. A variable that exists but holds the wrong
    // value is a conflict to resolve by hand, not a thing to create twice.
    if (bindingFor(proposal.tokenRef)) continue;
    refs.add(proposal.tokenRef);
  }
  return [...refs];
}

async function createVariables(requested?: string[]): Promise<void> {
  const snapshot = state.snapshot;
  const index = state.index;
  if (!snapshot || !index) {
    fail("Nothing has been checked yet.");
    return;
  }

  const refs = requested && requested.length > 0 ? requested : missingTokenRefs();
  if (refs.length === 0) {
    figma.notify("Every token the queue needs already exists.");
    return;
  }

  await busy(async () => {
    status(`Creating ${refs.length} ${refs.length === 1 ? "variable" : "variables"}…`);
    const result = await createMissingVariables(refs, snapshot, index);
    state.quietUntil = Date.now() + SELF_WRITE_QUIET_MS;

    figma.notify(
      result.created.length === 0
        ? `No variables created — ${result.skipped[0]?.reason ?? "nothing to do"}.`
        : `Created ${result.created.length} ${result.created.length === 1 ? "variable" : "variables"} in "${result.collectionName}". One undo removes them.`,
    );

    postApplied(
      {
        batchId: "create-variables",
        label: `New variables in ${result.collectionName}`,
        tokenRef: result.created.map((entry) => entry.figmaName).join(", ") || "none",
        applied: result.created.length,
        failed: result.skipped.length,
        failures: result.skipped.map((entry) => `${entry.ref}: ${entry.reason}`).slice(0, 5),
        undoable: result.created.length > 0,
      },
      "add",
    );

    // The variables exist now, so the index and every proposal are stale.
    state.index = null;
    await fullLint();
  });
}

/**
 * Every safe batch, one undo step, one report afterwards.
 *
 * A batch whose token cannot be resolved is dropped from the run rather than
 * failing it — the rest of the fix is still worth having, and the panel names
 * what was left behind.
 */
async function runAutofix(): Promise<void> {
  const report = state.report;
  const index = state.index;
  if (!report || !index) {
    fail("Nothing has been checked yet.");
    return;
  }

  const safe = report.batches.filter((batch) => batch.safe);
  if (safe.length === 0) {
    figma.notify("Nothing here is safe to bind unattended.");
    return;
  }

  const plan: ApplyOptions[] = [];
  const unresolved: string[] = [];
  for (const batch of safe) {
    const proposal = batch.proposal;
    if (!proposal || !isFixProposal(proposal)) continue;
    const binding = bindingFor(proposal.tokenRef);
    if (!binding) {
      unresolved.push(proposal.tokenRef);
      continue;
    }
    const expected = expectedValueFor(proposal.tokenRef);
    plan.push({
      batch,
      tokenRef: proposal.tokenRef,
      binding,
      index,
      ...(expected ? { expected } : {}),
    });
  }

  if (plan.length === 0) {
    fail(`None of the proposed tokens could be resolved (${unresolved.slice(0, 3).join(", ")}).`);
    return;
  }

  const layers = plan.reduce((sum, item) => sum + item.batch.count, 0);

  await busy(async () => {
    status(`Autofixing ${layers} ${layers === 1 ? "layer" : "layers"}…`);
    const outcome = await applyAll(plan);
    state.quietUntil = Date.now() + SELF_WRITE_QUIET_MS;

    figma.notify(
      outcome.failed > 0
        ? `Autofix bound ${outcome.applied} of ${layers} — ${outcome.failed} failed.`
        : `Autofix bound ${outcome.applied} ${outcome.applied === 1 ? "layer" : "layers"} across ${plan.length} ${plan.length === 1 ? "batch" : "batches"}. One undo reverts all of it.`,
    );

    postApplied(
      {
        batchId: "autofix",
        label: `Autofix · ${plan.length} ${plan.length === 1 ? "batch" : "batches"}`,
        tokenRef: `${plan.length} ${plan.length === 1 ? "token" : "tokens"}`,
        applied: outcome.applied,
        failed: outcome.failed,
        failures: [
          ...outcome.failures,
          ...(unresolved.length > 0 ? [`Skipped: ${unresolved.join(", ")}`] : []),
        ].slice(0, 5),
        undoable: outcome.applied > 0,
      },
      "autofix",
    );
  });

  // Fresh index + full walk. Incremental patching left bound layers in the
  // queue, so Bind 130 looked like it only did a slice and needed another click.
  state.index = null;
  await fullLint();
}

async function relintAffected(batch: Batch): Promise<void> {
  await relintItems(batch.items);
}

/**
 * Re-walks just the layers a fix touched, then re-runs the pure pass once.
 *
 * Deduped and linted ONCE for the whole set — an autofix over six batches must
 * not run six full rule passes, and a layer that appears in two batches must not
 * be walked twice.
 */
async function relintItems(items: readonly BatchItem[]): Promise<void> {
  if (!state.ir || items.length === 0) return;
  const located = indexIr(state.ir.root);
  const seen = new Set<string>();

  for (const item of items) {
    if (seen.has(item.nodeId)) continue;
    seen.add(item.nodeId);
    const location = located.get(item.nodeId);
    if (!location) continue;
    const node = await figma.getNodeByIdAsync(item.nodeId);
    if (!node || (node as SceneNode).removed) continue;
    const fresh = await traverseSubtree(node as SceneNode, location.node.depth, state.caches);
    if (location.parent) location.parent.children[location.index] = fresh;
    else state.ir = { ...state.ir, root: fresh };
  }

  runLint("incremental");
  if (state.heatmapOn && state.ir) heatmap.draw(state.ir);
}

/**
 * What the theme says this token holds, rendered for comparison. A library
 * variable's value cannot be read until it is imported, so this travels with the
 * apply and is checked on the other side.
 */
function expectedValueFor(ref: string): string | undefined {
  const snapshot = state.snapshot;
  if (!snapshot) return undefined;
  const color = snapshot.colors.find((entry) => entry.ref === ref);
  if (color) return color.hex;
  const number =
    snapshot.spaces.find((entry) => entry.ref === ref) ??
    snapshot.radii.find((entry) => entry.ref === ref);
  return number ? String(number.px) : undefined;
}

function bindingFor(ref: string) {
  const snapshot = state.snapshot;
  if (!snapshot) return undefined;
  const pools = [
    snapshot.colors,
    snapshot.spaces,
    snapshot.radii,
    snapshot.types,
    snapshot.shadows,
    snapshot.gradients,
  ];
  for (const pool of pools) {
    const hit = pool.find((entry) => entry.ref === ref);
    if (hit?.binding) return hit.binding;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Selection, heatmap, panel, export
// ---------------------------------------------------------------------------

function selectBatchLayers(batchId: string): void {
  const batch = state.report?.batches.find((b) => b.id === batchId);
  if (!batch) return;

  void (async () => {
    const nodes: SceneNode[] = [];
    for (const item of batch.items) {
      const node = await figma.getNodeByIdAsync(item.nodeId);
      if (node && !(node as SceneNode).removed) nodes.push(node as SceneNode);
    }
    if (nodes.length === 0) {
      figma.notify("Those layers are gone. Refresh the report.");
      return;
    }
    figma.currentPage.selection = nodes;
    figma.viewport.scrollAndZoomIntoView(nodes);
  })();
}

function toggleHeatmap(on: boolean): void {
  state.heatmapOn = on;
  if (!on) {
    heatmap.clearStaleOverlays();
    post({ type: "heatmap", on: false, nodes: 0 });
    return;
  }
  if (!state.ir) {
    post({ type: "heatmap", on: false, nodes: 0 });
    return;
  }
  const result = heatmap.draw(state.ir);
  if (result.truncated) {
    figma.notify(`Heatmap drawn for the first ${result.nodes} layers.`);
  }
  post({ type: "heatmap", on: true, nodes: result.nodes });
}

async function selectTheme(themeId: string): Promise<void> {
  if (!themeById(themeId)) {
    fail("That theme isn't bundled into this build.");
    return;
  }
  state.themeId = themeId;
  await figma.clientStorage.setAsync(CLIENT_STORAGE_THEME_KEY, themeId);

  // A different tenant means different names, different values, and therefore a
  // different set of bindable tokens — every batch is re-proposed.
  await busy(async () => {
    if (!state.index) state.index = await loadBindingIndex(state.caches.variables.keys());
    const theme = themeById(themeId)!;
    status(`Reconciling ${theme.name}…`);
    state.snapshot = await reconcile(theme, state.index);
    runLint("full");
  });
}

async function setPanelState(next: PanelState): Promise<void> {
  applyPanelSize(next);
  await figma.clientStorage.setAsync(CLIENT_STORAGE_KEY, next);
}

/**
 * Resize, then tell the UI what it actually got.
 *
 * The panel deliberately does not flip its own layout on a click. If the resize
 * throws — and it is the one call here that talks to the host window — the UI
 * keeps drawing the layout that matches the window that exists, instead of a
 * collapsed bar floating in a tall box.
 */
function applyPanelSize(next: PanelState): void {
  const size = PANEL_SIZES[next];
  try {
    figma.ui.resize(size.width, size.height);
    state.panelState = next;
  } catch (err) {
    console.log(`[fanos-studio] resize to ${size.width}x${size.height} failed: ${errorMessage(err)}`);
  }
  post({ type: "panel-state", state: state.panelState });
}

async function readPanelState(): Promise<PanelState> {
  try {
    const stored = await figma.clientStorage.getAsync(CLIENT_STORAGE_KEY);
    return stored === "collapsed" ? "collapsed" : "expanded";
  } catch {
    return "expanded";
  }
}

async function readStoredTheme(): Promise<string | undefined> {
  try {
    const stored = await figma.clientStorage.getAsync(CLIENT_STORAGE_THEME_KEY);
    return typeof stored === "string" ? stored : undefined;
  } catch {
    return undefined;
  }
}

async function readStoredApiOrigin(): Promise<string | undefined> {
  try {
    const stored = await figma.clientStorage.getAsync(CLIENT_STORAGE_API_ORIGIN_KEY);
    return typeof stored === "string" ? stored : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Figma's fetch, narrowed to the client's contract. The URL is a string and
 * headers are a plain object — that is what the sandbox accepts.
 */
const sandboxFetch: ApiFetch = (url: string, init: ApiFetchInit) => fetch(url, init);

/**
 * Compile the checked frame and render it, without persisting anything.
 *
 * Runs the walk again rather than reusing `state.ir`: the marked assets have to
 * be exported as bytes anyway, and a preview built from a stale walk would
 * answer a question about a frame the designer has since edited — which is the
 * one failure a preview cannot have.
 *
 * The compiler runs on the BOARD, not here. `@fanos/compile` imports
 * `@fanos/surface-canvas/ir`, so a plugin that imported it would close a
 * dependency cycle and the workspace would have no valid build order. Surface
 * Studio sits downstream of both and already owns the renderer, so it is the
 * one place the real compiler and the real renderer can meet — which also means
 * this preview is produced by exactly the code a real run uses, and cannot
 * flatter the result.
 */
async function previewCompile(): Promise<void> {
  const root = await resolveRoot(false);
  if (!root) {
    fail("Nothing to preview. Select the frame you want compiled.");
    return;
  }
  const api = state.api;
  if (!api) {
    postPreviewFailure("Surface Studio is not configured.");
    return;
  }

  await busy(async () => {
    post({ type: "preview-progress", message: "Walking the frame…" });
    const result = await runExport(root, state.caches, (message) =>
      post({ type: "preview-progress", message }),
    );

    post({ type: "preview-progress", message: "Compiling…" });
    const response = await api.previewCompile({
      ir: JSON.parse(result.json) as unknown,
      theme: rawThemeFileFor(state.themeId),
      assets: result.assets.map((asset) => ({
        name: asset.name,
        bytesBase64: bytesToBase64(asset.bytes),
      })),
    });

    if (!response.ok) {
      postPreviewFailure(
        response.status === null
          ? `${response.message} — is Surface Studio running? (pnpm dev)`
          : response.message,
      );
      return;
    }

    post({
      type: "preview-done",
      html: response.data.html,
      width: response.data.width,
      summary: response.data.summary,
      error: null,
    });
  });
}

function postPreviewFailure(message: string): void {
  post({ type: "preview-done", html: null, width: 0, summary: null, error: message });
}

async function exportIr(mode: "local" | "publish"): Promise<void> {
  const root = await resolveRoot(false);
  if (!root) {
    fail("Nothing to export. Select the frame you want the IR for.");
    return;
  }
  await busy(async () => {
    const result = await runExport(root, state.caches, (message) =>
      post({ type: "export-progress", message }),
    );
    const summary = result.summary as unknown as Record<string, unknown>;
    const publish =
      mode === "publish" ? await publishExport(root, result, summary) : { kind: "local" as const };
    post({
      type: "export-done",
      jsonName: result.jsonName,
      json: result.json,
      screenshots: result.screenshots,
      assets: result.assets,
      summary,
      publish,
    });
  });
}

/**
 * Same files the ZIP would hold. A down board must not eat the walk — the
 * result is still posted, and Save ZIP is the way out.
 */
async function publishExport(
  root: SceneNode,
  result: Awaited<ReturnType<typeof runExport>>,
  summary: Record<string, unknown>,
): Promise<ExportPublish> {
  const origin = state.api?.origin ?? "unknown";
  if (!state.api) {
    return { kind: "failed", origin, message: "API client never started." };
  }
  post({ type: "export-progress", message: "Sending to Surface Studio…" });
  const sent = await state.api.postExport(
    buildExportBody({
      page: currentPageRef(root),
      at: Date.now(),
      jsonName: result.jsonName,
      json: result.json,
      summary,
      screenshots: result.screenshots,
      assets: result.assets,
    }),
  );
  if (sent.ok) return { kind: "sent", origin };
  return { kind: "failed", origin, message: sent.message };
}

function currentPageRef(root: SceneNode): StudioPage {
  return {
    fileKey: typeof figma.fileKey === "string" ? figma.fileKey : null,
    fileName: figma.root.name,
    pageName: figma.currentPage.name,
    rootNodeId: root.id,
    rootName: root.name,
  };
}

function postSelection(): void {
  const selection = figma.currentPage.selection;
  const only = selection.length === 1 ? selection[0]! : null;
  const parent = only && only.parent && "id" in only.parent && only.parent.type !== "PAGE" && only.parent.type !== "DOCUMENT"
    ? only.parent
    : null;
  post({
    type: "selection",
    count: selection.length,
    name: only ? only.name : null,
    // Only containers are offerable as a root — a selected text layer is not a
    // page to check.
    id: only && "children" in only ? only.id : null,
    nodeId: only ? only.id : null,
    hasImage: only ? "fills" in only : false,
    parentId: parent && "id" in parent ? parent.id : null,
    parentName: parent && "name" in parent ? parent.name : null,
  });
}

function readBindings(): AssetBinding[] {
  return state.root ? parseBindings(state.root.getPluginData(ASSET_PLUGIN_KEY)) : [];
}

function writeBindings(bindings: AssetBinding[]): void {
  if (!state.root) return;
  state.root.setPluginData(ASSET_PLUGIN_KEY, serializeBindings(bindings));
  postAssets();
}

/**
 * The assets, where each lands, and where else each could go.
 *
 * Placement and target options are computed by the SAME functions the compiler
 * uses, from the same IR, so the panel's "covers its target" and the tree that
 * comes out cannot disagree.
 */
function postAssets(): void {
  const bindings = readBindings();
  post({
    type: "assets",
    bindings,
    placements: state.ir ? placementsFromIr(state.ir.root, bindings) : {},
    targets: state.ir ? targetOptionsFromIr(state.ir.root, bindings) : {},
  });
}

async function sceneNode(id: string): Promise<SceneNode | null> {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || node.type === "PAGE" || node.type === "DOCUMENT") return null;
  return node as SceneNode;
}

// ---------------------------------------------------------------------------
// Uploaded assets
// ---------------------------------------------------------------------------

/**
 * Take a dropped image, work out which region it is, and bind it there.
 *
 * The bytes go into the FIGMA DOCUMENT via `figma.createImage`, not into
 * pluginData. pluginData is a small key-value store on a node; a 3MB header
 * base64s to 4MB and would not survive there. The document's image store has no
 * such ceiling, dedupes by content hash, and persists across reopening the
 * file — so a binding only ever carries the hash.
 *
 * The mapping is a guess with a confidence, and it says so. A confident match
 * is applied; anything less is returned as ranked candidates for the designer
 * to pick from, because a background painted onto the wrong element is harder
 * to notice than one that was never placed.
 */
async function uploadAsset(message: {
  fileName: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  targetId?: string;
}): Promise<void> {
  if (!state.root || !state.ir) {
    fail("Check a frame first, then drop the image in.");
    return;
  }

  let image: Image;
  try {
    image = figma.createImage(message.bytes);
  } catch (err) {
    // Figma refuses images past its own size ceiling. That is a fact about the
    // file, not a bug, and the designer needs the reason rather than a stack.
    fail(`Figma would not accept "${message.fileName}": ${errorMessage(err)}`);
    return;
  }

  const existing = readBindings();
  const upload = {
    fileName: message.fileName,
    width: message.width,
    height: message.height,
  };

  const taken = new Set(existing.map((b) => b.targetId));
  const matches = matchAssetToTargets(state.ir.root, upload, { taken });

  // An explicit target wins over the matcher: the designer is answering the
  // question the matcher was asking.
  const chosenId = message.targetId ?? (isConfident(matches) ? matches[0]!.id : undefined);
  if (!chosenId) {
    post({
      type: "asset-unmapped",
      fileName: message.fileName,
      imageHash: image.hash,
      width: message.width,
      height: message.height,
      candidates: matches,
    });
    return;
  }

  const target = await sceneNode(chosenId);
  if (!target) {
    fail("That element is no longer in this frame.");
    return;
  }

  const taken_names = new Set(
    existing.filter((b) => b.imageHash !== image.hash).map((b) => b.name),
  );
  const binding: AssetBinding = {
    role: "background",
    name: suggestAssetName(message.fileName, taken_names),
    imageHash: image.hash,
    fileName: message.fileName,
    width: Math.max(1, message.width),
    height: Math.max(1, message.height),
    targetId: target.id,
    targetName: target.name,
    // An exported region fills the element it came from.
    fit: "cover",
    mapping: message.targetId ? "manual" : "auto",
  };

  writeBindings(upsertBinding(existing, binding));
  figma.notify(`"${message.fileName}" paints ${target.name}`);
}

/**
 * Bind an already-registered image to an element the designer picked.
 *
 * Split from `uploadAsset` because the bytes are already in the document:
 * re-running `createImage` on an answer would either duplicate the image or,
 * with no bytes to hand, throw.
 */
async function placeAsset(message: {
  imageHash: string;
  fileName: string;
  width: number;
  height: number;
  targetId: string;
}): Promise<void> {
  const target = await sceneNode(message.targetId);
  if (!target) {
    fail("That element is no longer in this frame.");
    return;
  }

  const existing = readBindings();
  const taken = new Set(existing.filter((b) => b.imageHash !== message.imageHash).map((b) => b.name));

  writeBindings(
    upsertBinding(existing, {
      role: "background",
      name: suggestAssetName(message.fileName, taken),
      imageHash: message.imageHash,
      fileName: message.fileName,
      width: Math.max(1, message.width),
      height: Math.max(1, message.height),
      targetId: target.id,
      targetName: target.name,
      fit: "cover",
      mapping: "manual",
    }),
  );
  figma.notify(`"${message.fileName}" paints ${target.name}`);
}

async function retargetAsset(key: string, targetId: string): Promise<void> {
  const target = await sceneNode(targetId);
  if (!target) {
    fail("Pick the element this image should paint.");
    return;
  }
  writeBindings(retargetBinding(readBindings(), key, { id: target.id, name: target.name }));
}

function removeAsset(key: string): void {
  writeBindings(removeBinding(readBindings(), key));
}

function renameAsset(key: string, name: string): void {
  const result = renameBinding(readBindings(), key, name.trim());
  if (!result.ok) {
    fail(result.error);
    return;
  }
  writeBindings(result.bindings);
}

function setAssetFit(key: string, fit: AssetFit): void {
  writeBindings(setBindingFit(readBindings(), key, fit));
}


// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

async function busy<T>(work: () => Promise<T>): Promise<T | undefined> {
  state.busy = true;
  try {
    return await work();
  } catch (err) {
    fail(errorMessage(err));
    return undefined;
  } finally {
    state.busy = false;
    status("", false);
  }
}

function currentActor(): ActivityActor {
  const user = figma.currentUser;
  if (!user) return { id: null, name: "Anonymous", color: "#6b6b6b" };
  return { id: user.id, name: user.name, color: user.color };
}

function readActivity(node: SceneNode): ActivityEntry[] {
  const keys = node.getPluginDataKeys().filter((key) => key.startsWith(ACTIVITY_PREFIX));
  return mergeActivity(keys.map((key) => parseLane(node.getPluginData(key))));
}

function recordActivity(node: SceneNode, entry: ActivityEntry): void {
  const key = laneKey(entry.actor.id);
  const next = appendLane(parseLane(node.getPluginData(key)), entry);
  node.setPluginData(key, JSON.stringify(next));
}

function retractActivity(node: SceneNode, entryId: string | null): void {
  const key = laneKey(currentActor().id);
  const next = popLane(parseLane(node.getPluginData(key)), entryId ?? undefined);
  node.setPluginData(key, next.length > 0 ? JSON.stringify(next) : "");
}

function postApplied(partial: Omit<AppliedPayload, "user">, kind?: ActivityKind): void {
  const user = currentActor();
  const payload: AppliedPayload = { ...partial, user };
  if (kind && payload.applied > 0 && state.root) {
    const entry: ActivityEntry = {
      id: `${user.id ?? "anon"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      actor: user,
      kind,
      label: payload.label,
      tokenRef: payload.tokenRef,
      applied: payload.applied,
      at: Date.now(),
    };
    recordActivity(state.root, entry);
    state.lastActivityId = entry.id;
  }
  post({ type: "applied", payload });
}

function post(message: PluginMessage): void {
  figma.ui.postMessage(message);
}

function status(message: string, isBusy = true): void {
  post({ type: "status", message, busy: isBusy });
}

function fail(message: string): void {
  console.log(`[fanos-studio] ${message}`);
  post({ type: "error", message });
}
