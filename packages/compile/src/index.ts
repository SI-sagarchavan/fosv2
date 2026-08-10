/**
 * @fanos/compile — Figma IR to DSL tree, with no model in the loop.
 *
 * Pairs with @fanos/conform: this produces the tree, that proves it is faithful.
 */

export { compile } from "./compile.js";
export type { CompileNote, CompileOptions, CompileResult } from "./compile.js";
export { classify, flowChildren, hasAbsoluteChild, isFillPlate, isIconGroup, isRule } from "./classify.js";
export type { DslType } from "./classify.js";
export { IdAllocator, isMeaningful, slug } from "./ids.js";
export { canonicalRef, candidates, paintRef } from "./refs.js";
export { length, place, raw, round, size, space, stack, text } from "./props.js";
export { SurfaceResolver, specOf } from "./surfaces.js";
export type { RequiredSurface } from "./surfaces.js";
