/**
 * Traversal and normalization: Figma nodes -> Frame IR. FIGMA-AWARE.
 *
 * Lifted out of the old `code.ts` unchanged, because it is the one piece of
 * Figma-specific reading in the plugin and both halves of Studio need it: the
 * Health tab lints the IR, the Export tab writes it to disk. There is exactly
 * one traversal, so the two can never disagree about what the page contains.
 *
 * The rule engine downstream of this is pure — see src/health/.
 */
import {
  IR_VERSION,
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

export type Caches = {
  variables: Map<string, string | null>;
  styles: Map<string, string | null>;
};

export function newCaches(): Caches {
  return { variables: new Map(), styles: new Map() };
}

/** Called every YIELD_EVERY nodes so the UI can show movement. */
export type ProgressFn = (message: string, nodes: number) => void;

/**
 * Walks `rootNode` into a validated-shaped Frame IR document.
 *
 * Signatures are annotated after the walk, which is why this is one function
 * rather than a generator — `repeatedSiblings` needs the whole tree.
 */
export async function traverseToDocument(
  rootNode: SceneNode,
  caches: Caches,
  onProgress: ProgressFn = () => {},
): Promise<{ document: FrameIRDocument; walk: WalkResult }> {
  const walk = await traverse(rootNode, caches, onProgress);
  annotateTree(walk.root);
  return {
    document: {
      fileKey: figma.fileKey ?? null,
      fileName: figma.root.name,
      pageName: figma.currentPage.name,
      rootNodeId: rootNode.id,
      extractedAt: new Date().toISOString(),
      irVersion: IR_VERSION,
      breakpointHint: walk.root.geometry.bbox.w,
      root: walk.root,
      assets: [],
    },
    walk,
  };
}

/**
 * Re-walks one subtree. This is what makes incremental re-lint cheap: a
 * `documentchange` names the nodes that changed, and only those subtrees go
 * back to Figma.
 */
export async function traverseSubtree(
  node: SceneNode,
  depth: number,
  caches: Caches,
): Promise<FrameIRNode> {
  const walk = await traverse(node, caches, () => {}, depth);
  annotateTree(walk.root);
  return walk.root;
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

export type WalkResult = {
  root: FrameIRNode;
  nodeCount: number;
  skippedInvisible: number;
  extractionErrors: number;
};

type StackItem = { node: SceneNode; parent: FrameIRNode | null; depth: number };

export async function traverse(
  rootNode: SceneNode,
  caches: Caches,
  onProgress: ProgressFn = () => {},
  startDepth = 0,
): Promise<WalkResult> {
  const stack: StackItem[] = [{ node: rootNode, parent: null, depth: startDepth }];
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
      onProgress(`Walking node tree… ${nodeCount} nodes`, nodeCount);
      await yieldToEventLoop();
    }
  }

  if (!root) throw new Error("Traversal produced no root node.");
  return { root, nodeCount, skippedInvisible, extractionErrors };
}

export function childrenOf(node: SceneNode): readonly SceneNode[] {
  return "children" in node ? (node as ChildrenMixin).children : [];
}

export function countDescendants(node: SceneNode): number {
  let total = 0;
  const stack: SceneNode[] = [...childrenOf(node)];
  while (stack.length > 0) {
    const current = stack.pop()!;
    total++;
    for (const child of childrenOf(current)) stack.push(child);
  }
  return total;
}

export function yieldToEventLoop(): Promise<void> {
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
      rotation: 0,
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

  // Figma reports degrees counter-clockwise. Normalised into (-180, 180] so a
  // consumer can test for a quarter turn without repeating the modulo dance.
  const rotation = "rotation" in node ? normalizeRotation(node.rotation) : 0;

  return { bbox, relBbox, rotation, aspect, aspectBucket: bucketAspect(aspect) };
}

/** Fold any angle into (-180, 180]. Figma stays in range, but instances drift. */
export function normalizeRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  const wrapped = ((degrees % 360) + 540) % 360 - 180;
  return round(wrapped === -180 ? 180 : wrapped, 2);
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

/**
 * The paint the IR reports, and therefore the paint a fix must rewrite: the last
 * visible one, which is the topmost on screen.
 *
 * Exported so `fix.ts` writes to the same slot `extractFill` read from. Two
 * copies of this rule would eventually disagree and the plugin would bind a
 * variable to a paint nobody can see.
 */
export function topmostVisibleIndex(paints: readonly Paint[]): number | undefined {
  for (let i = paints.length - 1; i >= 0; i--) {
    if (paints[i]!.visible !== false) return i;
  }
  return undefined;
}


async function extractFill(node: SceneNode, caches: Caches): Promise<Fill | null> {
  if (!("fills" in node)) return null;
  const fills = node.fills;
  if (fills === figma.mixed) return { raw: "MIXED", unbound: true };
  const visible = fills.filter((p) => p.visible !== false);
  if (visible.length === 0) return null;

  const index = topmostVisibleIndex(fills)!;
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

  const index = topmostVisibleIndex(strokes)!;
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
    if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
      const shadow = effect as DropShadowEffect | InnerShadowEffect;
      entry.x = round(shadow.offset.x, 3);
      entry.y = round(shadow.offset.y, 3);
      entry.blur = round(shadow.radius, 3);
      entry.spread = round(shadow.spread ?? 0, 3);
      entry.color = rgbaToHex(shadow.color, 1);
      entry.opacity = Math.round((shadow.color.a ?? 1) * 100);
      entry.inset = effect.type === "INNER_SHADOW";
    } else if (effect.type === "LAYER_BLUR" || effect.type === "BACKGROUND_BLUR") {
      entry.blur = round((effect as BlurEffect).radius, 3);
    }
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
// Stats + misc
// ---------------------------------------------------------------------------

export function sanitize(name: string): string {
  return name.replace(/[^a-z0-9\-_ ]/gi, "_").trim() || "untitled";
}

export function round(value: number, places: number): number {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

