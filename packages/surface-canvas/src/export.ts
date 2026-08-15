/**
 * The Export tab: Frame IR JSON + one PNG per section candidate. FIGMA-AWARE.
 *
 * This is the original extractor, unchanged in behaviour and moved behind a
 * function so the Health tab can share the traversal. It is still the thing that
 * feeds the corpus; Health is what makes the corpus worth having.
 */
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

export type ExportSummary = {
  nodeCount: number;
  screenshotCount: number;
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

  onProgress("Validating IR…", walk.nodeCount);
  const parsed = safeParseFrameIRDocument(document);

  onProgress("Exporting screenshots…", walk.nodeCount);
  const shots = await exportSectionCandidates(rootNode, onProgress);

  const coverage = coverageFromSlots(enumerateSlots(walk.root));
  const summary: ExportSummary = {
    nodeCount: walk.nodeCount,
    screenshotCount: shots.images.length,
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
    jsonName: fileNameFor(document),
    // Compact, not pretty-printed. At depth 18 a 2-space indent tripled the
    // file for no benefit — nobody reads a 6 MB IR document by eye, and
    // `jq .` restores it on demand.
    json: JSON.stringify(document),
    screenshots: shots.images,
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
