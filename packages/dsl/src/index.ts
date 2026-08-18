/**
 * @fanos/dsl — the SDUI vocabulary.
 *
 * The second half of T0. `@fanos/tokens` owns token names and values; this
 * package owns node shapes and consumes those tokens as types.
 *
 * Five consumers derive from here and none may be hand-maintained: the web
 * renderer's prop types, the validator that gates every generated tree, the
 * JSON Schema handed to the codegen agent, Surface Admin's form controls, and
 * the docs.
 */

export { SCHEMA_VERSION } from "./version.js";

// Part 1 — wire format
export {
  childrenOf,
  depths,
  flatten,
  flatNodeSchema,
  flatTreeSchema,
  isSynthetic,
  nodeById,
  reify,
  ReifyError,
  rootOf,
  syntheticSrc,
} from "./flat.js";
export type { FlatNode, FlatTree, Node, ReifyErrorCode } from "./flat.js";

// Part 2 — value wrappers
export {
  ANCHORS,
  isRaw,
  isRespObject,
  isSignedTokenRef,
  isTokenRef,
  PERCENT_RE,
  RATIO_RE,
  raw,
  refCategory,
  respValues,
  SEMVER_REF_RE,
  SIGNED_TOKEN_REF_RE,
  TOKEN_REF_RE,
  unsignRef,
} from "./values.js";
export type {
  Anchor,
  BreakpointKey,
  OffsetValue,
  Percent,
  Raw,
  Resp,
  RespObject,
  SizeValue,
  TokenRef,
  Val,
} from "./values.js";

// Field descriptors — the single source every representation derives from
export {
  ACTION_KINDS,
  actionSchema,
  docTypeOf,
  f,
  field,
  jsonOfField,
  jsonOfFields,
  opt,
  predicateSchema,
  rawSchema,
  req,
  tsOfField,
  tsOfType,
  zodOfField,
  zodOfFields,
} from "./field.js";
export type { Action, Field, Fields, FieldType, JsonContext, JsonSchema, Predicate } from "./field.js";

// Parts 3/4/5 — the vocabulary
export {
  allFields,
  isNodeType,
  LEAF_NODES,
  NODE_SPECS,
  NODE_TYPES,
  nodeSpec,
  STRUCTURAL_NODES,
} from "./nodes/index.js";
export type { NodeSpec } from "./nodes/index.js";
export {
  metaFields,
  placeFields,
  PLATFORMS,
  REPEATER_FORBIDDEN_PROPS,
  REVEALS,
  semanticsFields,
  sizeFields,
  spaceFields,
  universalFields,
  UNIVERSAL_PROP_NAMES,
} from "./universal.js";

// Part 6 — validation
export { analyze, ISSUE_CODES, issuesByCode, validate } from "./validate.js";
export type { Issue, IssueCode, ValidateOptions, ValidationResult } from "./validate.js";
export type { Metrics, RawValueCount } from "./metrics.js";
export { suggestRefs } from "./suggest.js";
export { walkFields, walkProps } from "./walk.js";
export type { LeafVisit, RespVisit, WalkHandlers } from "./walk.js";

// Part 7 — emission
export { emitTypes } from "./emit/types.js";
export { collectRefs, emitJsonSchema, selfReferentialDefs } from "./emit/json-schema.js";
export type { EmitJsonSchemaOptions } from "./emit/json-schema.js";
export { emitDocs } from "./emit/docs.js";

// Subtree signatures and collapse proposals
export {
  normaliseProps,
  stableJson,
  subtreeSignature,
  subtreeSignatures,
  SUBTREE_SIGNATURE_PREFIX,
} from "./subtree-signature.js";
export { sha1Hex } from "./sha1.js";
export { proposeCollapse } from "./collapse.js";
export type { CollapseProposal, VaryingContent } from "./collapse.js";

// Part 8 — tree operations
export {
  applyCollapse,
  collapseToRepeater,
  insertBefore,
  moveNode,
  removeNode,
  replaceNode,
  setProp,
  TreeOpError,
  wrapIn,
} from "./ops.js";
export type { Binding, CollapseOptions, RemoveOptions } from "./ops.js";
