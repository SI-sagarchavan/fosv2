/**
 * Library entry for the Frame IR.
 *
 * The plugin bundles (`dist/code.js`, `dist/ui.html`) are built by esbuild and
 * only run inside Figma. This entry is the other half: the IR schema and its
 * signature helpers, published as a plain ES module so downstream tooling —
 * `@fanos/conform`, and the compiler after it — can read an `.ir.json` without
 * taking a dependency on the Figma runtime.
 *
 * `schema.ts` was written with no Figma import for exactly this reason.
 */

export {
  IR_VERSION,
  frameIRDocumentSchema,
  frameIRNodeSchema,
  parseFrameIRDocument,
  safeParseFrameIRDocument,
} from "./schema.js";

export type {
  AspectBucket,
  AutoResize,
  Effect,
  Fill,
  FrameIRDocument,
  FrameIRNode,
  Geometry,
  ImageInfo,
  IRNodeType,
  Layout,
  LayoutMode,
  Padding,
  Positioning,
  Rect,
  Sizing,
  Stroke,
  TextInfo,
  TokenValue,
} from "./schema.js";

export {
  CANONICAL_DEPTH_LIMIT,
  SIGNATURE_DEPTH_LIMIT,
  computeCanonicalSignature,
  computeStructuralSignature,
} from "./signature.js";
