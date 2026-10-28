/**
 * Data interpolation for bound props — Text.content, Image.src/alt, Button.label
 * and Button.action.href.
 *
 * The grammar (`{path | pipe:arg}`), the pipes and the lookup live in
 * `@fanos/dsl`'s `binding.ts`, so this renderer, the native bundler and the
 * validator cannot disagree about what a ref means. This file only adapts it to
 * the renderer's call sites. No expressions, no eval.
 *
 * Unresolved refs render as their literal text and emit a warning — never the
 * string "undefined", and never "null" for a present-but-empty field.
 */

import { lookup as lookupPath, resolveTemplate, type ResolveOptions } from "@fanos/dsl";

export type DataBag = Record<string, unknown>;

export interface InterpolateResult {
  value: string;
  unresolved: string[];
}

/** Replace every `{ref}` in `template` with its value in `data`. */
export function interpolate(
  template: string,
  data: DataBag | undefined | null,
  options: ResolveOptions = {},
): InterpolateResult {
  return resolveTemplate(template, data ?? undefined, options);
}

/** Dot-path lookup; a numeric segment indexes an array. */
export function lookup(data: unknown, path: string): unknown {
  return lookupPath(data, path);
}

/** Log unresolved paths once per call site. Pure-friendly: returns warnings. */
export function formatUnresolvedWarnings(nodeId: string, prop: string, paths: string[]): string[] {
  return paths.map(
    (p) => `[fos-render] unresolved data path "{${p}}" on ${nodeId}.${prop} — left as literal`,
  );
}
