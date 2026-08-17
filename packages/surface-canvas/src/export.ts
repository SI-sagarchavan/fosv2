/**
 * The Export tab: Frame IR JSON + one PNG per section candidate. FIGMA-AWARE.
 *
 * This is the original extractor, unchanged in behaviour and moved behind a
 * function so the Health tab can share the traversal. It is still the thing that
 * feeds the corpus; Health is what makes the corpus worth having.
 */
import { applyAssetBindings, parseBindings } from "./assets.js";
import { ASSET_PLUGIN_KEY, type AssetBinding } from "./ir/schema";
import { safeParseFrameIRDocument, type FrameIRDocument } from "./ir/schema";
import { coverageFromSlots } from "./health/coverage.js";
import { enumerateSlots } from "./health/slots.js";
import {
  childrenOf,
  errorMessage,
  round,
  sanitize,
  traverseToDocument,
  type Caches,
  type ProgressFn,
  yieldToEventLoop,
} from "./traverse";

const MAX_SCREENSHOTS = 40;
const MIN_SCREENSHOT_WIDTH = 40;
const EXPORT_SCALE = 2;

export type Screenshot = { name: string; nodeId: string; bytes: Uint8Array };

export type ExportedAsset = {
  name: string;
  nodeId: string;
  targetNodeId: string;
  role: "background";
  bytes: Uint8Array;
  /**
   * `original` means these are the bytes the designer placed, straight out of
   * Figma's image store. `rendered` means the node was re-exported as a PNG
   * because the original was unreachable, which bakes in opacity, effects and
   * the node's on-canvas scale.
   *
   * Recorded because the two are not interchangeable downstream: an original is
   * what you want in object storage, and a render is a lossy stand-in worth
   * saying so about rather than shipping silently.
   */
  source: "original" | "rendered";
};

export type ExportSummary = {
  nodeCount: number;
  screenshotCount: number;
  assetCount: number;
  skippedInvisible: number;
  extractionErrors: number;
  /**
   * The SAME numbers the Health tab reports, from the same slot definition.
   *
   * These used to come from a second, older tally that skipped zero radii and
   * scored zero gaps as bound — so the two tabs quoted different coverage for
   * the same page and both of them sounded authoritative. One definition now,
   * in health/slots.ts, and a test asserts the two agree.
   */
  boundCount: number;
  looseCount: number;
  coveragePercent: number;
  screenshotsTruncated: boolean;
  screenshotCandidates: number;
  durationMs: number;
  schemaValid: boolean;
  schemaError?: string;
};

export interface ExportResult {
  jsonName: string;
  json: string;
  screenshots: Screenshot[];
  assets: ExportedAsset[];
  summary: ExportSummary;
}

export async function runExport(
  rootNode: SceneNode,
  caches: Caches,
  onProgress: ProgressFn,
): Promise<ExportResult> {
  const started = Date.now();

  onProgress("Walking node tree…", 0);
  const { document, walk } = await traverseToDocument(rootNode, caches, onProgress);
  const bindings = parseBindings(rootNode.getPluginData(ASSET_PLUGIN_KEY));
  const stamped = applyAssetBindings(document, bindings);

  onProgress("Validating IR…", walk.nodeCount);
  const parsed = safeParseFrameIRDocument(stamped);

  onProgress("Exporting screenshots…", walk.nodeCount);
  const shots = await exportSectionCandidates(rootNode, onProgress);

  onProgress("Exporting background assets…", walk.nodeCount);
  const assets = await exportMarkedAssets(stamped.assets, onProgress);

  const coverage = coverageFromSlots(enumerateSlots(walk.root));
  const summary: ExportSummary = {
    nodeCount: walk.nodeCount,
    screenshotCount: shots.images.length,
    assetCount: assets.length,
    skippedInvisible: walk.skippedInvisible,
    extractionErrors: walk.extractionErrors,
    boundCount: coverage.bound,
    looseCount: coverage.loose,
    coveragePercent: coverage.percent,
    screenshotsTruncated: shots.truncated,
    screenshotCandidates: shots.candidates,
    durationMs: Date.now() - started,
    schemaValid: parsed.success,
    ...(parsed.success
      ? {}
      : { schemaError: parsed.error.issues.slice(0, 3).map(issueLine).join("; ") }),
  };

  return {
    jsonName: fileNameFor(stamped),
    // Compact, not pretty-printed. At depth 18 a 2-space indent tripled the
    // file for no benefit — nobody reads a 6 MB IR document by eye, and
    // `jq .` restores it on demand.
    json: JSON.stringify(parsed.success ? parsed.data : stamped),
    screenshots: shots.images,
    assets,
    summary,
  };
}

/**
 * The root node id is in the name because fileName/pageName are not
 * distinguishing in practice: local dev plugins get no fileKey, and an
 * unpublished file reports "Untitled" / "Page 1". Two exports from different
 * frames of the same file would otherwise collide and one would silently
 * overwrite the other. "1:4366" -> "1-4366", matching the PNGs and Figma's own
 * ?node-id= URL form.
 */
function fileNameFor(document: FrameIRDocument): string {
  const frame = sanitize(document.root.name);
  const id = document.rootNodeId.replace(/:/g, "-");
  return `${frame}-${id}.ir.json`;
}

function issueLine(issue: { path: (string | number)[]; message: string }): string {
  return `${issue.path.join(".") || "<root>"}: ${issue.message}`;
}

async function exportSectionCandidates(
  rootNode: SceneNode,
  onProgress: ProgressFn,
): Promise<{ images: Screenshot[]; truncated: boolean; candidates: number }> {
  const children = childrenOf(rootNode).filter((child) => child.visible !== false);

  const candidates = children.filter((child) => {
    const box = "absoluteBoundingBox" in child ? child.absoluteBoundingBox : null;
    const w = box?.width ?? child.width;
    const h = box?.height ?? child.height;
    return w * h > 0 && w >= MIN_SCREENSHOT_WIDTH;
  });

  const truncated = candidates.length > MAX_SCREENSHOTS;
  const selected = candidates.slice(0, MAX_SCREENSHOTS);
  if (truncated) {
    const msg = `Screenshot export capped at ${MAX_SCREENSHOTS} of ${candidates.length} section candidates.`;
    console.log(`[fanos-studio] ${msg}`);
    figma.notify(msg);
  }

  const images: Screenshot[] = [];
  for (let i = 0; i < selected.length; i++) {
    const child = selected[i]!;
    onProgress(`Exporting screenshots… ${i + 1}/${selected.length}`, 0);
    try {
      const bytes = await child.exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: EXPORT_SCALE },
      });
      // Node ids contain ":", which macOS save panels and Finder mangle.
      // "-" is how Figma itself encodes node ids in URLs, so this stays
      // recoverable: 13744-75493.png <-> node "13744:75493".
      const id = child.id.replace(/:/g, "-");
      images.push({
        name: `${sanitize(child.name)}-${id}.png`,
        nodeId: child.id,
        bytes,
      });
    } catch (err) {
      console.log(`[fanos-studio] export failed for ${child.id}: ${errorMessage(err)}`);
    }
    await yieldToEventLoop();
  }

  return { images, truncated, candidates: candidates.length };
}

/**
 * The uploaded bitmaps, read straight back out of the Figma document.
 *
 * No rendering, no flattening, no cloning. The designer exported the region
 * with Figma's own exporter — which honours export settings, scale and effects
 * — and `figma.createImage` put those exact bytes in the document. This hands
 * the same bytes on.
 *
 * That replaced a version of this function that re-rendered marked layers and,
 * for a multi-layer background, cloned them into a throwaway off-canvas frame
 * to flatten. It worked, but it re-implemented an exporter Figma already ships,
 * and it mutated the document to produce a picture.
 */
async function exportMarkedAssets(
  bindings: readonly AssetBinding[],
  onProgress: ProgressFn,
): Promise<ExportedAsset[]> {
  const assets: ExportedAsset[] = [];
  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i]!;
    onProgress(`Reading background assets… ${i + 1}/${bindings.length}`, 0);

    const image = figma.getImageByHash(binding.imageHash);
    if (!image) {
      // The document no longer holds those bytes. Loud, because the run would
      // otherwise resolve this asset to nothing and the page would render
      // without a background nobody removed.
      console.log(
        `[fanos-studio] image ${binding.imageHash} for "${binding.name}" is not in this document`,
      );
      continue;
    }

    try {
      assets.push({
        name: binding.name,
        nodeId: binding.targetId,
        targetNodeId: binding.targetId,
        role: "background",
        bytes: await image.getBytesAsync(),
        // Always the file the designer exported, never something we drew.
        source: "original",
      });
    } catch (err) {
      console.log(`[fanos-studio] could not read "${binding.name}": ${errorMessage(err)}`);
    }
    await yieldToEventLoop();
  }
  return assets;
}


