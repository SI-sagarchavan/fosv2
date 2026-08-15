/**
 * @fanos/renderer/harness — the acceptance harness.
 *
 * Boots headless Chromium, renders a tree to a PNG, pixel-diffs it against the
 * Figma screenshot, and maps the differing regions back to node ids. These are
 * the eyes of the fidelity gate: `generate → render → diff`.
 *
 * Split from the main entry because it drags Playwright, pngjs and pixelmatch
 * behind it. Those belong in CI and on a developer's machine, never in the
 * dependency graph of a client-facing site — which is the whole reason this is
 * a separate export rather than a folder inside the app.
 */
export { measureNodeBoxes, renderToPng, writePng, closeBrowser } from "./harness/renderToPng.js";
export type { MeasuredBox, RenderToPngOptions } from "./harness/renderToPng.js";
export { diff, findRegions } from "./harness/diff.js";
export type { DiffResult, DiffRegion } from "./harness/diff.js";
export { mapRegionsToNodes, COLLECT_NODE_BOXES_SCRIPT } from "./harness/mapRegions.js";
export type { NodeBox, RegionNodes } from "./harness/mapRegions.js";
