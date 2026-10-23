/**
 * The shared first step: IR + theme -> compiled tree.
 *
 * Both the inspector and the bindings analysis begin here, and neither imports
 * the other — they meet in this file so the dependency runs one way.
 */
import { compile, type CompileResult } from "@fanos/compile";
import type { FlatTree } from "@fanos/dsl";
import { parseFrameIRDocument, type FrameIRDocument } from "@fanos/surface-canvas/ir";
import { parseThemeJson, type NormalizedTheme, type SurfaceSet } from "@fanos/tokens";

import type { DslTree, Json } from "../src/inspect-types.js";

/** What both `inspect` and `analyzeBindings` start from. */
export interface Pipeline {
  doc: FrameIRDocument;
  theme: NormalizedTheme;
  compiled: CompileResult;
  surfaces: SurfaceSet;
}

export interface PipelineInput {
  ir: unknown;
  /** The RAW theme file. */
  theme: unknown;
  icons?: Readonly<Record<string, string>> | undefined;
}

export function runPipeline(input: PipelineInput): Pipeline {
  const doc = parseFrameIRDocument(input.ir);
  const theme = parseThemeJson(input.theme)[0];
  if (!theme) throw new Error("the theme carries no tokens");

  const compiled = compile(doc, { theme, ...(input.icons ? { icons: input.icons } : {}) });

  // The surfaces this compile needs but the theme does not have yet. Merged in
  // for validation exactly as `fos-compile` does: a tree that names a surface
  // nobody has written is not wrong, and reporting T1 for each would bury the
  // errors that are.
  const surfaces: SurfaceSet = {
    assets: new Map<string, string>(),
    surfaces: new Map(compiled.requiredSurfaces.map((s) => [s.name, s.spec] as const)),
  };

  return { doc, theme, compiled, surfaces };
}

/** The `surfaces` argument `renderPreview` takes: plain objects, not Maps. */
export function surfacesForRender(compiled: CompileResult): { assets: Record<string, string>; surfaces: Record<string, unknown> } {
  return {
    assets: {},
    surfaces: Object.fromEntries(compiled.requiredSurfaces.map((s) => [s.name, s.spec])),
  };
}

/** FlatTree -> the wire shape. The same data; the cast is only about `unknown`. */
export function wireTree(tree: FlatTree): DslTree {
  return {
    schemaVersion: tree.schemaVersion,
    nodes: tree.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      parent: n.parent,
      idx: n.idx,
      src: n.src,
      props: n.props as Record<string, Json>,
    })),
  };
}

