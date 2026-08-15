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
 * A consumer must know which of these a corpus row was produced with, so the
 * version is part of every document.
 *
 * Hidden nodes are not in the document: they are skipped during traversal, as
 * in 1.0.0. Should that ever change, it is a version bump, not a silent one —
 * a corpus row's node set must be inferable from its `irVersion` alone.
 */
export const IR_VERSION = "1.2.0" as const;
export const IR_VERSIONS = ["1.1.0", "1.2.0"] as const;

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

export const frameIRNodeSchema: z.ZodType<FrameIRNode> = z.lazy(() =>
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
});
export type FrameIRDocument = z.infer<typeof frameIRDocumentSchema>;

/** Runtime validator. Returns the parsed document or throws a ZodError. */
export function parseFrameIRDocument(input: unknown): FrameIRDocument {
  return frameIRDocumentSchema.parse(input);
}

/** Non-throwing variant, for reporting validation state in the plugin UI. */
export function safeParseFrameIRDocument(input: unknown) {
  return frameIRDocumentSchema.safeParse(input);
}
