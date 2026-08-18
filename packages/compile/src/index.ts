/**
 * @fanos/compile — Figma IR to DSL tree, with no model in the loop.
 *
 * Pairs with @fanos/conform: this produces the tree, that proves it is faithful.
 */

export { compile } from "./compile.js";
export type { CompileNote, CompileOptions, CompileResult, RequiredAsset } from "./compile.js";
export {
  classify,
  flowChildren,
  hasAbsoluteChild,
  isDecorativeVector,
  isFillPlate,
  isIconGroup,
  isRule,
  paintsAsSurface,
} from "./classify.js";
export type { DslType, PrimitiveMap } from "./classify.js";
export { declaredType, primitivesFromNames, PRIMITIVE_PREFIX } from "./primitives.js";
export { IdAllocator, isMeaningful, slug } from "./ids.js";
export { canonicalRef, candidates, paintRef } from "./refs.js";
export { length, place, raw, round, size, space, stack, text } from "./props.js";
export { SurfaceResolver, specOf } from "./surfaces.js";
export type { RequiredSurface } from "./surfaces.js";
