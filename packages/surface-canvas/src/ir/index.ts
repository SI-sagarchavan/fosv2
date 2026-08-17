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
  ASSET_NAME_RE,
  ASSET_PLUGIN_KEY,
  IR_VERSION,
  IR_VERSIONS,
  assetBindingSchema,
  assetFitSchema,
  assetRef,
  fitFromScaleMode,
  frameIRDocumentSchema,
  assetMappingSchema,
  frameIRNodeSchema,
  isValidAssetName,
  parseFrameIRDocument,
  safeParseFrameIRDocument,
} from "./schema.js";

export {
  COVER_TOLERANCE,
  assetPlacement,
  compositePlacement,
  targetOptions,
  unionBox,
} from "./placement.js";
export type { AssetPlacement, TargetOption } from "./placement.js";

export { MAX_ICON_PX, countPaths, hasText, isVectorOnly } from "./artwork.js";

export {
  AUTO_APPLY_SCORE,
  isConfident,
  matchAssetToTargets,
  normalizeFileName,
} from "./match-asset.js";
export type { TargetMatch, UploadedImage } from "./match-asset.js";

export type {
  AspectBucket,
  AssetBinding,
  AssetFit,
  AssetMapping,
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
