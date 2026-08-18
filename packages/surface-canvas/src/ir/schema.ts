/**
 * Frame IR — the normalized shape every Figma node collapses into.
 *
 * This module is the single source of truth for both the TypeScript types and
 * the runtime validator. It has no Figma dependency so it can be imported from
 * tests, CI, and (later) downstream generation tooling.
 */
import { z } from "zod";

/**
 * 1.2.0 — adds effect geometry (`x`, `y`, `blur`, `spread`, `color`, `opacity`,
 * `inset`) so F6 can value-match a shadow token. 1.1.0 documents still parse;
 * those fields are simply absent and F6 cannot propose.
 *
 * 1.3.0 — adds `assets` on the document and `background` on a node. A designer
 * marks a static image in Surface Canvas and binds it to the UI element it
 * should paint. Older documents still parse: the list is empty and no node
 * carries a background.
 *
 * 1.4.0 — adds `fit` to a binding. Figma's `scaleMode` was being read at compile
 * time and flattened to `cover` for everything that was not `FIT`, which turned
 * a tiled pattern into one stretched copy of itself. The designer's choice now
 * travels with the mark instead of being re-guessed downstream. Absent on 1.3.0
 * documents, where the compiler falls back to the source node's `image.fit`.
 *
 * 1.5.0 — a binding took `sources`, a LIST of the Figma layers making up one
 * background. Superseded by 1.6.0; see below.
 *
 * 1.6.0 — an asset is an UPLOADED IMAGE, not a set of marked layers.
 *
 * Marking layers was the wrong shape for the problem. It asked the designer to
 * re-describe, inside a panel, a composition Figma already understood — and it
 * asked the plugin to re-flatten what Figma's own exporter flattens correctly,
 * with export settings, scale and effects honoured. A designer exports the
 * region the normal way and drops the file in; the only thing left to work out
 * is which region it came from, and that is a matching problem rather than an
 * authoring one.
 *
 * So a binding now carries `imageHash` — the bytes live in the Figma document
 * via `figma.createImage`, so they survive reopening the file — plus the
 * filename and natural size that the mapping was inferred from.
 *
 * Bindings in an older shape are DROPPED on parse rather than failing the
 * document: they name Figma layers, and there are no uploaded bytes behind
 * them to recover. A corpus row from 1.3.0–1.5.0 still parses, with an empty
 * asset list.
 *
 * A consumer must know which of these a corpus row was produced with, so the
 * version is part of every document.
 *
 * 1.7.0 — adds `truncation` and `maxLines` to a text node.
 *
 * `autoResize` alone could not say that a text is clamped. It carries Figma's
 * OLD truncation mode, which current Figma does not produce: a designer today
 * sets `textTruncation: ENDING` on an auto-height layer, and the layer reports
 * `autoResize: "HEIGHT"` like any other. The clamp was therefore invisible, and
 * a news card whose Figma box is two lines tall rendered all 474 characters of
 * its body copy — six of them in one section, which took a 444px band to 837px
 * and left the design unrecognisable inside its own clip.
 *
 * Both fields are optional and absent on 1.1.0–1.6.0 documents, which still
 * parse and still compile exactly as they did: no clamp is inferred from a box
 * that merely looks too small, because a text that genuinely flows is
 * indistinguishable from one that is clamped without Figma saying so.
 *
 * Hidden nodes are not in the document: they are skipped during traversal, as
 * in 1.0.0. Should that ever change, it is a version bump, not a silent one —
 * a corpus row's node set must be inferable from its `irVersion` alone.
 */
export const IR_VERSION = "1.7.0" as const;
export const IR_VERSIONS = [
  "1.1.0",
  "1.2.0",
  "1.3.0",
  "1.4.0",
  "1.5.0",
  "1.6.0",
  "1.7.0",
] as const;

/** pluginData key on the export root. The list of bindings lives on the frame. */
export const ASSET_PLUGIN_KEY = "fanos/assets";

/**
 * How the bitmap fills the box it paints.
 *
 * Named after the CSS/DSL vocabulary rather than Figma's `scaleMode`, because
 * this is what the compiler emits and what the renderer honours. The mapping
 * from Figma happens once, at the point of marking — see {@link fitFromScaleMode}.
 */
export const assetFitSchema = z.enum(["cover", "contain", "repeat", "none"]);
export type AssetFit = z.infer<typeof assetFitSchema>;

/**
 * Figma's `scaleMode` -> our fit.
 *
 * `CROP` collapses to `cover` deliberately: the crop rectangle the designer
 * dragged is not in the IR, so `cover` is the closest honest approximation and
 * pretending otherwise would invent a box. `TILE` is the one that used to be
 * lost — it is a repeating pattern, and rendering it as `cover` stretches a
 * single copy across the whole element.
 */
export function fitFromScaleMode(scaleMode: string | undefined): AssetFit {
  switch (scaleMode) {
    case "FIT":
      return "contain";
    case "TILE":
      return "repeat";
    case "CROP":
    case "FILL":
      return "cover";
    default:
      return "cover";
  }
}

/** How the target was decided. */
export const assetMappingSchema = z.enum(["auto", "manual"]);
export type AssetMapping = z.infer<typeof assetMappingSchema>;

/**
 * An image the designer exported from Figma and dropped into the panel, bound
 * to the element it should paint.
 *
 * Distinct from a content Image (`src` is a CMS binding). This is a file that
 * ships with the template. The compiler turns `name` into `asset.texture.<name>`.
 *
 * The bytes are NOT in here. They live in the Figma document, registered with
 * `figma.createImage`, and `imageHash` is how to get them back. That is what
 * lets a 3MB header survive a reload: pluginData holds a hash, not a payload,
 * and there is no size ceiling to run into.
 */
export const assetBindingSchema = z.object({
  role: z.literal("background"),
  name: z.string().min(1),
  /** Figma image store handle. `figma.getImageByHash(hash).getBytesAsync()`. */
  imageHash: z.string().min(1),
  /** What the designer dropped. Kept because it is what the mapping read. */
  fileName: z.string(),
  /** Natural pixel size of the upload — not the target's box. */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  targetId: z.string().min(1),
  targetName: z.string(),
  fit: assetFitSchema.optional(),
  /**
   * Whether the target was inferred or chosen.
   *
   * Recorded because an auto-mapping is a guess with a confidence, and a
   * designer who later finds the wrong region painted needs to know whether
   * they picked it or the matcher did.
   */
  mapping: assetMappingSchema.default("auto"),
});
export type AssetBinding = z.infer<typeof assetBindingSchema>;

/**
 * A valid asset name: lowercase, digits, underscores.
 *
 * The name becomes half of a token ref, so it is design-system identity rather
 * than a label — `asset.texture.Top Header!` is not addressable. Enforced here
 * so the plugin, the compiler and the token registry cannot disagree about what
 * is nameable.
 */
export const ASSET_NAME_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export function isValidAssetName(name: string): boolean {
  return ASSET_NAME_RE.test(name);
}

/**
 * A binding field that drops anything in an older shape instead of failing.
 *
 * `assets` is not the only place a stale binding hides: 1.3.0-1.5.0 documents
 * also stamped one onto every target node, and a strict field there rejects the
 * whole document — so a corpus row saved before the redesign could not be read
 * at all. The list and the stamps have to be equally forgiving, or the
 * tolerance is decorative.
 */
const tolerantBinding = z
  .unknown()
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    const parsed = assetBindingSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  });

/** `tickets_plate` -> `asset.texture.tickets_plate`. */
export function assetRef(name: string): string {
  return `asset.texture.${name}`;
}

export const nodeTypeSchema = z.enum([
  "FRAME",
  "GROUP",
  "TEXT",
  "IMAGE",
  "VECTOR",
  "INSTANCE",
  "COMPONENT",
  "OTHER",
]);
export type IRNodeType = z.infer<typeof nodeTypeSchema>;

export const layoutModeSchema = z.enum(["vertical", "horizontal", "none"]);
export type LayoutMode = z.infer<typeof layoutModeSchema>;

export const sizingSchema = z.enum(["hug", "fill", "fixed"]);
export type Sizing = z.infer<typeof sizingSchema>;

export const positioningSchema = z.enum(["auto", "absolute"]);
export type Positioning = z.infer<typeof positioningSchema>;

export const aspectBucketSchema = z.enum([
  "square",
  "portrait",
  "landscape",
  "wide",
  "ultrawide",
]);
export type AspectBucket = z.infer<typeof aspectBucketSchema>;

export const autoResizeSchema = z.enum([
  "NONE",
  "HEIGHT",
  "WIDTH_AND_HEIGHT",
  "TRUNCATE",
]);
export type AutoResize = z.infer<typeof autoResizeSchema>;

/**
 * A numeric visual value plus its provenance.
 * `unbound` is true only when a non-zero value exists with no variable and no
 * style behind it — i.e. a hardcoded magic number worth reporting.
 */
export const tokenValueSchema = z.object({
  value: z.number(),
  tokenRef: z.string().optional(),
  unbound: z.boolean(),
});
export type TokenValue = z.infer<typeof tokenValueSchema>;

export const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type Rect = z.infer<typeof rectSchema>;

export const paddingSchema = z.object({
  top: tokenValueSchema,
  right: tokenValueSchema,
  bottom: tokenValueSchema,
  left: tokenValueSchema,
});
export type Padding = z.infer<typeof paddingSchema>;

export const layoutSchema = z.object({
  mode: layoutModeSchema,
  gap: tokenValueSchema.nullable(),
  padding: paddingSchema,
  align: z.string().nullable(),
  justify: z.string().nullable(),
  wrap: z.boolean(),
  sizing: z.object({ w: sizingSchema, h: sizingSchema }),
  positioning: positioningSchema,
});
export type Layout = z.infer<typeof layoutSchema>;

export const geometrySchema = z.object({
  bbox: rectSchema,
  relBbox: rectSchema,
  /**
   * Degrees counter-clockwise, as Figma reports it. 0 for an upright node.
   *
   * This is the fact that reconciles the two boxes. `bbox` comes from
   * `absoluteBoundingBox` — the axis-aligned extent AFTER rotation — while
   * `relBbox` carries `node.width/height`, the node's own dimensions BEFORE
   * it. For a quarter-turned node the two are transposed, and without this
   * field nothing downstream can tell that from a genuinely tall, narrow box.
   * A 552x1 rule rotated flat then compiles as a 552x552 square.
   *
   * Defaulted rather than required so IR captured before this existed still
   * parses; those documents simply assert no rotation, which is what they
   * always meant.
   */
  rotation: z.number().default(0),
  aspect: z.number(),
  aspectBucket: aspectBucketSchema,
});
export type Geometry = z.infer<typeof geometrySchema>;

export const fillSchema = z.object({
  tokenRef: z.string().optional(),
  styleId: z.string().optional(),
  styleRef: z.string().optional(),
  raw: z.string().optional(),
  unbound: z.boolean(),
});
export type Fill = z.infer<typeof fillSchema>;

export const strokeSchema = z.object({
  tokenRef: z.string().optional(),
  styleId: z.string().optional(),
  styleRef: z.string().optional(),
  raw: z.string().optional(),
  weight: z.number(),
  unbound: z.boolean(),
});
export type Stroke = z.infer<typeof strokeSchema>;

export const effectSchema = z.object({
  type: z.string(),
  tokenRef: z.string().optional(),
  styleId: z.string().optional(),
  styleRef: z.string().optional(),
  unbound: z.boolean(),
  /** Present from IR 1.2.0. Absent on 1.1.0 corpus rows. */
  x: z.number().optional(),
  y: z.number().optional(),
  blur: z.number().optional(),
  spread: z.number().optional(),
  color: z.string().optional(),
  /** 0–100, matching `@fanos/tokens` ShadowValue. */
  opacity: z.number().optional(),
  inset: z.boolean().optional(),
});
export type Effect = z.infer<typeof effectSchema>;

/** Figma's `textTruncation`. Only `ENDING` is recorded; see `textSchema`. */
export const truncationSchema = z.enum(["ENDING"]);
export type Truncation = z.infer<typeof truncationSchema>;

export const textSchema = z.object({
  characters: z.string(),
  styleRef: z.string().optional(),
  styleId: z.string().optional(),
  unbound: z.boolean(),
  fontSize: z.number(),
  fontFamily: z.string(),
  fontWeight: z.union([z.string(), z.number()]),
  lineHeight: z.union([z.number(), z.literal("auto")]),
  autoResize: autoResizeSchema,
  lines: z.number(),
  /**
   * Present only when the layer is clamped (1.7.0+).
   *
   * `DISABLED` is not recorded, for the same reason an unset padding is not
   * written as `0`: absence already means it. That does make absence ambiguous
   * between "not clamped" and "document too old to say", but both answers lead
   * to the same place — no clamp — so nothing downstream has to tell them apart.
   */
  truncation: truncationSchema.optional(),
  /**
   * Figma's `maxLines`, when the designer pinned one.
   *
   * Null in Figma means "clamp at whatever the box holds" rather than "do not
   * clamp", so it is omitted here and the consumer falls back to `lines` — the
   * count the box itself implies.
   */
  maxLines: z.number().optional(),
});
export type TextInfo = z.infer<typeof textSchema>;

export const imageSchema = z.object({
  fit: z.string(),
  hasImageFill: z.boolean(),
});
export type ImageInfo = z.infer<typeof imageSchema>;

/**
 * Declared explicitly because the schema is recursive — z.infer cannot see
 * through z.lazy without a hand-written seed type.
 */
export interface FrameIRNode {
  id: string;
  name: string;
  type: IRNodeType;
  componentKey?: string;

  layout: Layout;
  geometry: Geometry;

  fill: Fill | null;
  stroke: Stroke | null;
  radius: TokenValue | null;
  effects: Effect[];
  opacity: number;
  clipsContent: boolean;

  text?: TextInfo;
  image?: ImageInfo;
  /**
   * The marked background that should paint this node.
   *
   * Present on the TARGET. Every layer the asset is made of carries the same
   * binding on {@link FrameIRNode.asset}. The document-level `assets` list is
   * the source of truth; these stamps are so a walker does not have to join.
   */
  background?: AssetBinding;

  /** Derived during traversal — never read back from Figma. */
  structuralSignature: string;
  /** Looser shape hash that collapses one component's variants. */
  canonicalSignature: string;
  repeatedSiblings: number;
  depth: number;
  childCount: number;

  /** Present only when normalization of this node threw. */
  extractionError?: string;

  children: FrameIRNode[];
}

/**
 * Input is `unknown`, not `FrameIRNode`.
 *
 * `geometry.rotation` carries a default, so what this accepts is no longer the
 * same shape it produces — a document written before that field existed is
 * valid input and gains `rotation: 0` on the way out. The parse input is
 * untrusted JSON in every real call site anyway.
 */
export const frameIRNodeSchema: z.ZodType<FrameIRNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    type: nodeTypeSchema,
    componentKey: z.string().optional(),

    layout: layoutSchema,
    geometry: geometrySchema,

    fill: fillSchema.nullable(),
    stroke: strokeSchema.nullable(),
    radius: tokenValueSchema.nullable(),
    effects: z.array(effectSchema),
    opacity: z.number(),
    clipsContent: z.boolean(),

    text: textSchema.optional(),
    image: imageSchema.optional(),
    background: tolerantBinding,

    structuralSignature: z.string(),
    canonicalSignature: z.string(),
    repeatedSiblings: z.number().int().min(1),
    depth: z.number().int().min(0),
    childCount: z.number().int().min(0),

    extractionError: z.string().optional(),

    children: z.array(frameIRNodeSchema),
  }),
);

export const frameIRDocumentSchema = z.object({
  fileKey: z.string().nullable(),
  fileName: z.string(),
  pageName: z.string(),
  rootNodeId: z.string(),
  extractedAt: z.string(),
  irVersion: z.enum(IR_VERSIONS),
  breakpointHint: z.number(),
  root: frameIRNodeSchema,
  /**
   * Uploaded background assets for this frame. Empty on documents from before
   * 1.3.0, and on frames where nothing has been dropped in.
   *
   * Entries that do not match the current shape are DROPPED rather than
   * failing the document. 1.3.0-1.5.0 bindings name Figma layers and have no
   * uploaded bytes behind them, so there is nothing to migrate — and a corpus
   * row from before the redesign must still parse, or every downstream tool
   * loses its history to a feature change.
   */
  assets: z
    .array(z.unknown())
    .default([])
    .transform((items) =>
      items.flatMap((item) => {
        const parsed = assetBindingSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
});
export type FrameIRDocument = z.infer<typeof frameIRDocumentSchema>;

/**
 * Runtime validator. Returns the parsed document or throws a ZodError — except
 * for one case it can explain far better than Zod can.
 *
 * A plugin that has been reloaded ahead of the service reading its exports
 * produces a version this build has never heard of, and the raw failure is a
 * wall of enum JSON that names every version EXCEPT the one that would tell you
 * what happened. The document is almost certainly fine; the reader is old. That
 * is a deployment fact, not a schema fact, so it is worth saying out loud —
 * twice over in development, where "the dist changed but this process started
 * before it" is a normal Tuesday.
 */
export function parseFrameIRDocument(input: unknown): FrameIRDocument {
  const result = frameIRDocumentSchema.safeParse(input);
  if (result.success) return result.data;

  const stale = result.error.issues.find(
    (issue) => issue.path.length === 1 && issue.path[0] === "irVersion",
  );
  if (stale) {
    const sent = (input as { irVersion?: unknown } | null)?.irVersion;
    throw new Error(
      `this build reads Frame IR up to ${IR_VERSION}, and the document says ${String(sent)}. ` +
        `Whatever produced it is newer than whatever is reading it — rebuild and restart the ` +
        `service (in development, a process started before the last build still holds the old schema).`,
    );
  }
  throw result.error;
}

/** Non-throwing variant, for reporting validation state in the plugin UI. */
export function safeParseFrameIRDocument(input: unknown) {
  return frameIRDocumentSchema.safeParse(input);
}
