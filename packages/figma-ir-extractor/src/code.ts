/**
 * FanOS IR Extractor — sandbox side.
 *
 * Walks the selected frame, normalizes every node into Frame IR, exports PNGs
 * of the root's direct children, and hands both to the UI iframe for download.
 * No network access, no plugin data, no persistence.
 */
import {
  IR_VERSION,
  safeParseFrameIRDocument,
  type AspectBucket,
  type Effect,
  type Fill,
  type FrameIRDocument,
  type FrameIRNode,
  type IRNodeType,
  type ImageInfo,
  type Layout,
  type Padding,
  type Rect,
  type Sizing,
  type Stroke,
  type TextInfo,
  type TokenValue,
} from "./ir/schema";
import { annotateTree } from "./ir/signature";

const YIELD_EVERY = 500;
const MAX_SCREENSHOTS = 40;
const MIN_SCREENSHOT_WIDTH = 40;
const EXPORT_SCALE = 2;

/** Text properties Figma allows variable bindings on. */
const TEXT_VARIABLE_KEYS = [
  "fontSize",
  "fontFamily",
  "fontStyle",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "paragraphSpacing",
  "paragraphIndent",
  "characters",
] as const;

type Caches = {
  variables: Map<string, string | null>;
  styles: Map<string, string | null>;
};

type Summary = {
  nodeCount: number;
  screenshotCount: number;
  skippedInvisible: number;
  extractionErrors: number;
  unboundCount: number;
  boundCount: number;
  unboundPercent: number;
  screenshotsTruncated: boolean;
  screenshotCandidates: number;
  durationMs: number;
  schemaValid: boolean;
  schemaError?: string;
};

// ---------------------------------------------------------------------------
// Plugin bootstrap
// ---------------------------------------------------------------------------

figma.showUI(__html__, { width: 380, height: 420, themeColors: true });

figma.ui.onmessage = (msg: { type?: string }) => {
  if (msg && msg.type === "export") {
    void run();
  } else if (msg && msg.type === "cancel") {
    figma.closePlugin();
  }
};

postSelectionState();
figma.on("selectionchange", postSelectionState);

function postSelectionState(): void {
  const selection = figma.currentPage.selection;
  figma.ui.postMessage({
    type: "selection",
    count: selection.length,
    name: selection.length === 1 ? selection[0]!.name : null,
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const started = Date.now();
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    fail("Nothing selected. Select the page frame you want to extract.");
    return;
  }
  if (selection.length > 1) {
    fail(
      `${selection.length} nodes selected. Select exactly one root frame and try again.`,
    );
    return;
  }

  const rootNode = selection[0]!;

  try {
    progress("Walking node tree…", 0);
    const caches: Caches = { variables: new Map(), styles: new Map() };
    const walk = await traverse(rootNode, caches);

    progress("Computing signatures…", walk.nodeCount);
    annotateTree(walk.root);

    const document: FrameIRDocument = {
      fileKey: figma.fileKey ?? null,
      fileName: figma.root.name,
      pageName: figma.currentPage.name,
      rootNodeId: rootNode.id,
      extractedAt: new Date().toISOString(),
      irVersion: IR_VERSION,
      breakpointHint: walk.root.geometry.bbox.w,
      root: walk.root,
    };

    progress("Validating IR…", walk.nodeCount);
    const parsed = safeParseFrameIRDocument(document);

    progress("Exporting screenshots…", walk.nodeCount);
    const shots = await exportSectionCandidates(rootNode);

    const bindStats = countBindings(walk.root);
    const summary: Summary = {
      nodeCount: walk.nodeCount,
      screenshotCount: shots.images.length,
      skippedInvisible: walk.skippedInvisible,
      extractionErrors: walk.extractionErrors,
      unboundCount: bindStats.unbound,
      boundCount: bindStats.bound,
      unboundPercent:
        bindStats.total === 0
          ? 0
          : Math.round((bindStats.unbound / bindStats.total) * 1000) / 10,
      screenshotsTruncated: shots.truncated,
      screenshotCandidates: shots.candidates,
      durationMs: Date.now() - started,
      schemaValid: parsed.success,
      ...(parsed.success
        ? {}
        : { schemaError: parsed.error.issues.slice(0, 3).map(issueLine).join("; ") }),
    };

    // The root node id is in the name because fileName/pageName are not
    // distinguishing in practice: local dev plugins get no fileKey, and an
    // unpublished file reports "Untitled" / "Page 1". Two exports from
    // different frames of the same file would otherwise collide and one would
    // silently overwrite the other. "1:4366" -> "1-4366", matching the PNGs
    // and Figma's own ?node-id= URL form.
    const safeFile = sanitize(document.fileName);
    const safePage = sanitize(document.pageName);
    const safeRoot = document.rootNodeId.replace(/:/g, "-");

    figma.ui.postMessage({
      type: "done",
      jsonName: `${safeFile}__${safePage}__${safeRoot}.ir.json`,
      // Compact, not pretty-printed. At depth 18 a 2-space indent tripled the
      // file for no benefit — nobody reads a 6 MB IR document by eye, and
      // `jq .` restores it on demand.
      json: JSON.stringify(document),
      screenshots: shots.images,
      summary,
    });
  } catch (err) {
    fail(errorMessage(err));
  }
}

function issueLine(issue: { path: (string | number)[]; message: string }): string {
  return `${issue.path.join(".") || "<root>"}: ${issue.message}`;
}

function fail(message: string): void {
  figma.notify(message, { error: true });
  figma.ui.postMessage({ type: "error", message });
}

function progress(message: string, nodes: number): void {
  figma.ui.postMessage({ type: "progress", message, nodes });
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

type WalkResult = {
  root: FrameIRNode;
  nodeCount: number;
  skippedInvisible: number;
  extractionErrors: number;
};

type StackItem = { node: SceneNode; parent: FrameIRNode | null; depth: number };

async function traverse(rootNode: SceneNode, caches: Caches): Promise<WalkResult> {
  const stack: StackItem[] = [{ node: rootNode, parent: null, depth: 0 }];
  let root: FrameIRNode | null = null;
  let nodeCount = 0;
  let skippedInvisible = 0;
  let extractionErrors = 0;

  while (stack.length > 0) {
    const item = stack.pop()!;
    const { node, parent, depth } = item;

    // Invisible subtrees are dropped wholesale — they never render, so they
    // cannot contribute to a shipped section. The count still lands in the
    // summary: on a real page hidden nodes outnumbered visible ones roughly
    // 3:1, which is worth knowing even when they are not being collected.
    if (node.visible === false) {
      skippedInvisible += 1 + countDescendants(node);
      continue;
    }

    let irNode: FrameIRNode;
    try {
      irNode = await normalize(node, depth, caches);
    } catch (err) {
      extractionErrors++;
      irNode = errorNode(node, depth, errorMessage(err));
    }

    if (parent) parent.children.push(irNode);
    else root = irNode;

    nodeCount++;

    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i]!, parent: irNode, depth: depth + 1 });
    }

    if (nodeCount % YIELD_EVERY === 0) {
      progress(`Walking node tree… ${nodeCount} nodes`, nodeCount);
      await yieldToEventLoop();
    }
  }

  if (!root) throw new Error("Traversal produced no root node.");
  return { root, nodeCount, skippedInvisible, extractionErrors };
}

function childrenOf(node: SceneNode): readonly SceneNode[] {
  return "children" in node ? (node as ChildrenMixin).children : [];
}

function countDescendants(node: SceneNode): number {
  let total = 0;
  const stack: SceneNode[] = [...childrenOf(node)];
  while (stack.length > 0) {
    const current = stack.pop()!;
    total++;
    for (const child of childrenOf(current)) stack.push(child);
  }
  return total;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

async function normalize(
  node: SceneNode,
  depth: number,
  caches: Caches,
): Promise<FrameIRNode> {
  const geometry = extractGeometry(node);
  const layout = await extractLayout(node, caches);

  const ir: FrameIRNode = {
    id: node.id,
    name: node.name,
    type: mapType(node),
    layout,
    geometry,
    fill: await extractFill(node, caches),
    stroke: await extractStroke(node, caches),
    radius: await extractRadius(node, caches),
    effects: await extractEffects(node, caches),
    opacity: "opacity" in node ? node.opacity : 1,
    clipsContent: "clipsContent" in node ? node.clipsContent : false,
    // Filled in by annotateTree after the walk completes.
    structuralSignature: "",
    canonicalSignature: "",
    repeatedSiblings: 1,
    depth,
    childCount: childrenOf(node).length,
    children: [],
  };

  const componentKey = await extractComponentKey(node);
  if (componentKey) ir.componentKey = componentKey;

  if (node.type === "TEXT") {
    ir.text = await extractText(node, caches);
  }

  const image = extractImage(node);
  if (image) ir.image = image;

  return ir;
}

/** A node that blew up mid-normalization still gets a slot in the tree. */
function errorNode(node: SceneNode, depth: number, message: string): FrameIRNode {
  return {
    id: node.id,
    name: node.name,
    type: "OTHER",
    layout: {
      mode: "none",
      gap: null,
      padding: zeroPadding(),
      align: null,
      justify: null,
      wrap: false,
      sizing: { w: "fixed", h: "fixed" },
      positioning: "auto",
    },
    geometry: {
      bbox: { x: 0, y: 0, w: 0, h: 0 },
      relBbox: { x: 0, y: 0, w: 0, h: 0 },
      aspect: 0,
      aspectBucket: "square",
    },
    fill: null,
    stroke: null,
    radius: null,
    effects: [],
    opacity: 1,
    clipsContent: false,
    structuralSignature: "",
    canonicalSignature: "",
    repeatedSiblings: 1,
    depth,
    childCount: 0,
    extractionError: message,
    children: [],
  };
}

function mapType(node: SceneNode): IRNodeType {
  switch (node.type) {
    case "FRAME":
      return "FRAME";
    case "GROUP":
      return "GROUP";
    case "TEXT":
      return "TEXT";
    case "INSTANCE":
      return "INSTANCE";
    case "COMPONENT":
      return "COMPONENT";
    case "RECTANGLE":
    case "ELLIPSE":
    case "POLYGON":
    case "STAR":
    case "LINE":
    case "VECTOR":
    case "BOOLEAN_OPERATION":
      // A shape whose entire fill is a bitmap reads as an image, not a vector.
      return hasImageFill(node) ? "IMAGE" : "VECTOR";
    default:
      return "OTHER";
  }
}

async function extractComponentKey(node: SceneNode): Promise<string | undefined> {
  if (node.type === "COMPONENT") return node.key;
  if (node.type === "INSTANCE") {
    // Sync `mainComponent` is unavailable under dynamic-page document access.
    const main = await node.getMainComponentAsync();
    return main?.key;
  }
  return undefined;
}

// --- geometry --------------------------------------------------------------

function extractGeometry(node: SceneNode) {
  const box = "absoluteBoundingBox" in node ? node.absoluteBoundingBox : null;
  const w = box?.width ?? ("width" in node ? node.width : 0);
  const h = box?.height ?? ("height" in node ? node.height : 0);

  const bbox: Rect = {
    x: box?.x ?? ("x" in node ? node.x : 0),
    y: box?.y ?? ("y" in node ? node.y : 0),
    w,
    h,
  };
  const relBbox: Rect = {
    x: "x" in node ? node.x : 0,
    y: "y" in node ? node.y : 0,
    w: "width" in node ? node.width : w,
    h: "height" in node ? node.height : h,
  };
  const aspect = h > 0 ? round(w / h, 4) : 0;

  return { bbox, relBbox, aspect, aspectBucket: bucketAspect(aspect) };
}

export function bucketAspect(aspect: number): AspectBucket {
  if (!isFinite(aspect) || aspect <= 0) return "square";
  if (aspect >= 3) return "ultrawide";
  if (aspect >= 1.9) return "wide";
  if (aspect > 1.05) return "landscape";
  if (aspect >= 0.95) return "square";
  return "portrait";
}

// --- layout ----------------------------------------------------------------

/** Structural view of the auto-layout properties, kept local so the code does
 *  not depend on which mixin interface a given plugin-typings version exports. */
type AutoLayoutish = {
  layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL";
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  counterAxisAlignItems?: string;
  primaryAxisAlignItems?: string;
  layoutWrap?: string;
};

async function extractLayout(node: SceneNode, caches: Caches): Promise<Layout> {
  const auto = node as SceneNode & AutoLayoutish;
  const layoutMode = auto.layoutMode ?? "NONE";
  const mode =
    layoutMode === "VERTICAL"
      ? "vertical"
      : layoutMode === "HORIZONTAL"
        ? "horizontal"
        : "none";

  const gap =
    layoutMode === "NONE"
      ? null
      : makeTokenValue(
          auto.itemSpacing ?? 0,
          await tokenRefFor(node, "itemSpacing", caches),
        );

  const padding: Padding =
    layoutMode === "NONE" && auto.paddingTop === undefined
      ? zeroPadding()
      : {
          top: makeTokenValue(
            auto.paddingTop ?? 0,
            await tokenRefFor(node, "paddingTop", caches),
          ),
          right: makeTokenValue(
            auto.paddingRight ?? 0,
            await tokenRefFor(node, "paddingRight", caches),
          ),
          bottom: makeTokenValue(
            auto.paddingBottom ?? 0,
            await tokenRefFor(node, "paddingBottom", caches),
          ),
          left: makeTokenValue(
            auto.paddingLeft ?? 0,
            await tokenRefFor(node, "paddingLeft", caches),
          ),
        };

  return {
    mode,
    gap,
    padding,
    align: auto.counterAxisAlignItems ?? null,
    justify: auto.primaryAxisAlignItems ?? null,
    wrap: auto.layoutWrap === "WRAP",
    sizing: extractSizing(node),
    positioning:
      (node as SceneNode & { layoutPositioning?: string }).layoutPositioning ===
      "ABSOLUTE"
        ? "absolute"
        : "auto",
  };
}

function extractSizing(node: SceneNode): { w: Sizing; h: Sizing } {
  const n = node as SceneNode & {
    layoutSizingHorizontal?: "HUG" | "FILL" | "FIXED";
    layoutSizingVertical?: "HUG" | "FILL" | "FIXED";
    layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL";
    primaryAxisSizingMode?: "FIXED" | "AUTO";
    counterAxisSizingMode?: "FIXED" | "AUTO";
  };

  const direct = (v?: "HUG" | "FILL" | "FIXED"): Sizing | null =>
    v === "HUG" ? "hug" : v === "FILL" ? "fill" : v === "FIXED" ? "fixed" : null;

  let w = direct(n.layoutSizingHorizontal);
  let h = direct(n.layoutSizingVertical);

  // Root frames and nodes outside an auto-layout parent report no layoutSizing;
  // fall back to the container's own axis sizing modes.
  if ((w === null || h === null) && n.layoutMode && n.layoutMode !== "NONE") {
    const primaryHug = n.primaryAxisSizingMode === "AUTO";
    const counterHug = n.counterAxisSizingMode === "AUTO";
    const horizontalHug =
      n.layoutMode === "HORIZONTAL" ? primaryHug : counterHug;
    const verticalHug = n.layoutMode === "VERTICAL" ? primaryHug : counterHug;
    if (w === null) w = horizontalHug ? "hug" : "fixed";
    if (h === null) h = verticalHug ? "hug" : "fixed";
  }

  return { w: w ?? "fixed", h: h ?? "fixed" };
}

function zeroPadding(): Padding {
  const zero = (): TokenValue => ({ value: 0, unbound: false });
  return { top: zero(), right: zero(), bottom: zero(), left: zero() };
}

/** Zero/absent values are never flagged — only real hardcoded numbers are. */
function makeTokenValue(value: number, tokenRef?: string): TokenValue {
  const rounded = round(value, 3);
  if (tokenRef) return { value: rounded, tokenRef, unbound: false };
  return { value: rounded, unbound: rounded !== 0 };
}

// --- paint / effects -------------------------------------------------------

async function extractFill(node: SceneNode, caches: Caches): Promise<Fill | null> {
  if (!("fills" in node)) return null;
  const fills = node.fills;
  if (fills === figma.mixed) return { raw: "MIXED", unbound: true };
  const visible = fills.filter((p) => p.visible !== false);
  if (visible.length === 0) return null;

  // Last paint in the array is the topmost one.
  const index = fills.indexOf(visible[visible.length - 1]!);
  const paint = fills[index]!;

  const tokenRef =
    (await paintTokenRef(paint, caches)) ??
    (await tokenRefForIndex(node, "fills", index, caches));
  const styleId = readStyleId(node, "fillStyleId");
  const styleRef = styleId ? await styleName(styleId, caches) : undefined;

  const fill: Fill = { unbound: !tokenRef && !styleId };
  if (tokenRef) fill.tokenRef = tokenRef;
  if (styleId) fill.styleId = styleId;
  if (styleRef) fill.styleRef = styleRef;
  if (fill.unbound) fill.raw = paintToRaw(paint);
  return fill;
}

async function extractStroke(
  node: SceneNode,
  caches: Caches,
): Promise<Stroke | null> {
  if (!("strokes" in node)) return null;
  const strokes = node.strokes;
  if (!strokes || strokes.length === 0) return null;
  const visible = strokes.filter((p) => p.visible !== false);
  if (visible.length === 0) return null;

  const index = strokes.indexOf(visible[visible.length - 1]!);
  const paint = strokes[index]!;

  const rawWeight = (node as SceneNode & { strokeWeight?: number | symbol })
    .strokeWeight;
  const weight =
    typeof rawWeight === "number"
      ? rawWeight
      : ((node as SceneNode & { strokeTopWeight?: number }).strokeTopWeight ?? 0);

  const tokenRef =
    (await paintTokenRef(paint, caches)) ??
    (await tokenRefForIndex(node, "strokes", index, caches));
  const styleId = readStyleId(node, "strokeStyleId");
  const styleRef = styleId ? await styleName(styleId, caches) : undefined;

  const stroke: Stroke = { weight: round(weight, 3), unbound: !tokenRef && !styleId };
  if (tokenRef) stroke.tokenRef = tokenRef;
  if (styleId) stroke.styleId = styleId;
  if (styleRef) stroke.styleRef = styleRef;
  if (stroke.unbound) stroke.raw = paintToRaw(paint);
  return stroke;
}

async function extractRadius(
  node: SceneNode,
  caches: Caches,
): Promise<TokenValue | null> {
  if (!("cornerRadius" in node)) return null;
  const raw = (node as SceneNode & { cornerRadius: number | symbol }).cornerRadius;
  const corners = node as SceneNode & { topLeftRadius?: number };
  const value = typeof raw === "number" ? raw : (corners.topLeftRadius ?? 0);

  const tokenRef =
    (await tokenRefFor(node, "topLeftRadius", caches)) ??
    (await tokenRefFor(node, "cornerRadius", caches));

  return makeTokenValue(value, tokenRef);
}

async function extractEffects(node: SceneNode, caches: Caches): Promise<Effect[]> {
  if (!("effects" in node)) return [];
  const effects = node.effects;
  if (!effects || effects.length === 0) return [];

  const styleId = readStyleId(node, "effectStyleId");
  const styleRef = styleId ? await styleName(styleId, caches) : undefined;

  const out: Effect[] = [];
  for (const effect of effects) {
    const bound = (effect as { boundVariables?: Record<string, VariableAlias> })
      .boundVariables;
    let tokenRef: string | undefined;
    if (bound) {
      for (const key of Object.keys(bound)) {
        const alias = bound[key];
        if (alias?.id) {
          tokenRef = await variableName(alias.id, caches);
          if (tokenRef) break;
        }
      }
    }
    const entry: Effect = { type: effect.type, unbound: !tokenRef && !styleId };
    if (tokenRef) entry.tokenRef = tokenRef;
    if (styleId) entry.styleId = styleId;
    if (styleRef) entry.styleRef = styleRef;
    out.push(entry);
  }
  return out;
}

function hasImageFill(node: SceneNode): boolean {
  return imagePaint(node) !== null;
}

function imagePaint(node: SceneNode): ImagePaint | null {
  if (!("fills" in node)) return null;
  const fills = node.fills;
  if (fills === figma.mixed) return null;
  for (const paint of fills) {
    if (paint.type === "IMAGE" && paint.visible !== false) return paint;
  }
  return null;
}

function extractImage(node: SceneNode): ImageInfo | undefined {
  const paint = imagePaint(node);
  if (!paint) return undefined;
  return { fit: paint.scaleMode ?? "FILL", hasImageFill: true };
}

/**
 * The unbound fallback: a lossless-enough string for anyone reproducing the
 * value downstream. Recording only `paint.type` would drop the actual colours
 * of every gradient, and on a real page gradients were the single largest
 * category of unbound fill — "never silently dropped" has to cover them.
 *
 *   SOLID            -> "#0b1e3f" / "#0b1e3f80"
 *   IMAGE            -> "IMAGE:FILL"
 *   GRADIENT_LINEAR  -> "GRADIENT_LINEAR(#fff 0%, #000 100%; m=[a,b,tx,c,d,ty])"
 *
 * The trailing matrix is Figma's `gradientTransform`, carried verbatim so the
 * gradient's geometry (angle, extent) is recoverable. Deriving an angle here
 * would mean guessing at a convention; the raw matrix cannot be wrong.
 */
function paintToRaw(paint: Paint): string {
  if (paint.type === "SOLID") return rgbaToHex(paint.color, paint.opacity ?? 1);
  if (paint.type === "IMAGE") return `IMAGE:${paint.scaleMode ?? "FILL"}`;

  const gradient = paint as GradientPaint;
  if (!gradient.gradientStops) return paint.type;

  const opacity = paint.opacity ?? 1;
  const stops = gradient.gradientStops
    .map((stop) => {
      const alpha = (stop.color.a ?? 1) * opacity;
      return `${rgbaToHex(stop.color, alpha)} ${round(stop.position * 100, 1)}%`;
    })
    .join(", ");

  const matrix = gradient.gradientTransform
    ? `; m=[${gradient.gradientTransform
        .map((row) => row.map((n) => round(n, 4)).join(","))
        .join(",")}]`
    : "";

  return `${paint.type}(${stops}${matrix})`;
}

function rgbaToHex(color: RGB, alpha: number): string {
  const channel = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  const hex = `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
  return alpha >= 1 ? hex : `${hex}${channel(alpha)}`;
}

// --- text ------------------------------------------------------------------

async function extractText(node: TextNode, caches: Caches): Promise<TextInfo> {
  const fontSize = resolveMixed<number>(
    node.fontSize,
    () => node.getRangeFontSize(0, 1),
    0,
  );
  const fontName = resolveMixed<FontName>(node.fontName, () => node.getRangeFontName(0, 1), {
    family: "",
    style: "",
  });
  const rawWeight = typeof node.fontWeight === "number" ? node.fontWeight : undefined;
  const lineHeightRaw = resolveMixed<LineHeight>(
    node.lineHeight,
    () => node.getRangeLineHeight(0, 1),
    { unit: "AUTO" },
  );

  const lineHeight: number | "auto" =
    lineHeightRaw.unit === "AUTO"
      ? "auto"
      : lineHeightRaw.unit === "PERCENT"
        ? round((fontSize * lineHeightRaw.value) / 100, 2)
        : round(lineHeightRaw.value, 2);

  const effectiveLineHeight =
    typeof lineHeight === "number" && lineHeight > 0 ? lineHeight : fontSize * 1.2;
  const lines =
    effectiveLineHeight > 0
      ? Math.max(1, Math.round(node.height / effectiveLineHeight))
      : 1;

  const styleId = readStyleId(node, "textStyleId");
  const styleRef = styleId ? await styleName(styleId, caches) : undefined;

  let variableRef: string | undefined;
  if (!styleId) {
    for (const key of TEXT_VARIABLE_KEYS) {
      variableRef = await tokenRefFor(node, key, caches);
      if (variableRef) break;
    }
  }

  const info: TextInfo = {
    characters: node.characters,
    unbound: !styleId && !variableRef,
    fontSize: round(fontSize, 2),
    fontFamily: fontName.family,
    fontWeight: typeof rawWeight === "number" ? rawWeight : fontName.style,
    lineHeight,
    autoResize: node.textAutoResize,
    lines,
  };
  if (styleId) info.styleId = styleId;
  // styleRef carries whichever binding exists — a text style name, else the
  // variable name. Never both; a bound node is never flagged unbound.
  const ref = styleRef ?? variableRef;
  if (ref) info.styleRef = ref;
  return info;
}

/** Unwraps figma.mixed by sampling the first character, with a hard fallback. */
function resolveMixed<T>(
  value: T | PluginAPI["mixed"],
  sample: () => T | PluginAPI["mixed"] | undefined,
  fallback: T,
): T {
  if (value !== figma.mixed) return value as T;
  try {
    const sampled = sample();
    if (sampled !== undefined && sampled !== figma.mixed) return sampled as T;
  } catch {
    // Ranged read failed (empty text node, unloaded font) — use the fallback.
  }
  return fallback;
}

// --- token resolution ------------------------------------------------------

type BoundVariables = Record<string, VariableAlias | VariableAlias[] | undefined>;

function boundVariablesOf(node: SceneNode): BoundVariables | undefined {
  return (node as SceneNode & { boundVariables?: BoundVariables }).boundVariables;
}

async function tokenRefFor(
  node: SceneNode,
  key: string,
  caches: Caches,
): Promise<string | undefined> {
  const bound = boundVariablesOf(node);
  const entry = bound?.[key];
  if (!entry) return undefined;
  const alias = Array.isArray(entry) ? entry[0] : entry;
  if (!alias?.id) return undefined;
  return variableName(alias.id, caches);
}

async function tokenRefForIndex(
  node: SceneNode,
  key: "fills" | "strokes",
  index: number,
  caches: Caches,
): Promise<string | undefined> {
  const entry = boundVariablesOf(node)?.[key];
  if (!Array.isArray(entry)) return undefined;
  const alias = entry[index] ?? entry[0];
  if (!alias?.id) return undefined;
  return variableName(alias.id, caches);
}

async function paintTokenRef(
  paint: Paint,
  caches: Caches,
): Promise<string | undefined> {
  const bound = (paint as Paint & { boundVariables?: { color?: VariableAlias } })
    .boundVariables;
  if (!bound?.color?.id) return undefined;
  return variableName(bound.color.id, caches);
}

/**
 * Variable names come back with "/" preserved — "color/brand/blue/700".
 * Files re-reference the same handful of variables hundreds of times, so every
 * lookup (including misses) is memoized.
 */
async function variableName(id: string, caches: Caches): Promise<string | undefined> {
  const cached = caches.variables.get(id);
  if (cached !== undefined) return cached ?? undefined;
  let name: string | null = null;
  try {
    const variable = await figma.variables.getVariableByIdAsync(id);
    name = variable ? variable.name : null;
  } catch {
    name = null;
  }
  caches.variables.set(id, name);
  return name ?? undefined;
}

async function styleName(id: string, caches: Caches): Promise<string | undefined> {
  const cached = caches.styles.get(id);
  if (cached !== undefined) return cached ?? undefined;
  let name: string | null = null;
  try {
    const style = await figma.getStyleByIdAsync(id);
    name = style ? style.name : null;
  } catch {
    name = null;
  }
  caches.styles.set(id, name);
  return name ?? undefined;
}

function readStyleId(node: SceneNode, key: string): string | undefined {
  const value = (node as unknown as Record<string, unknown>)[key];
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value;
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

type Screenshot = { name: string; nodeId: string; bytes: Uint8Array };

async function exportSectionCandidates(rootNode: SceneNode): Promise<{
  images: Screenshot[];
  truncated: boolean;
  candidates: number;
}> {
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
    console.log(`[fanos-ir] ${msg}`);
    figma.notify(msg);
  }

  const images: Screenshot[] = [];
  for (let i = 0; i < selected.length; i++) {
    const child = selected[i]!;
    progress(`Exporting screenshots… ${i + 1}/${selected.length}`, 0);
    try {
      const bytes = await child.exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: EXPORT_SCALE },
      });
      // Node ids contain ":", which macOS save panels and Finder mangle.
      // "-" is how Figma itself encodes node ids in URLs, so this stays
      // recoverable: 13744-75493.png <-> node "13744:75493".
      images.push({
        name: `${child.id.replace(/:/g, "-")}.png`,
        nodeId: child.id,
        bytes,
      });
    } catch (err) {
      console.log(`[fanos-ir] export failed for ${child.id}: ${errorMessage(err)}`);
    }
    await yieldToEventLoop();
  }

  return { images, truncated, candidates: candidates.length };
}

// ---------------------------------------------------------------------------
// Stats + misc
// ---------------------------------------------------------------------------

/**
 * Every visual slot we normalize is either bound (token/style) or flagged.
 * This counts both sides so the UI can report an unbound percentage that
 * actually means something. Hidden nodes never reach here — they are dropped
 * during traversal — so this is a statement about what shipped.
 */
function countBindings(root: FrameIRNode): {
  bound: number;
  unbound: number;
  total: number;
} {
  let bound = 0;
  let unbound = 0;
  const tally = (flag: boolean) => (flag ? unbound++ : bound++);

  const stack: FrameIRNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.fill) tally(node.fill.unbound);
    if (node.stroke) tally(node.stroke.unbound);
    if (node.radius && node.radius.value !== 0) tally(node.radius.unbound);
    if (node.layout.gap) tally(node.layout.gap.unbound);
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const pad = node.layout.padding[side];
      if (pad.value !== 0) tally(pad.unbound);
    }
    for (const effect of node.effects) tally(effect.unbound);
    if (node.text) tally(node.text.unbound);
    for (const child of node.children) stack.push(child);
  }

  return { bound, unbound, total: bound + unbound };
}

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9\-_ ]/gi, "_").trim() || "untitled";
}

function round(value: number, places: number): number {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
