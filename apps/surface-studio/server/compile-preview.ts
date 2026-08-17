/**
 * Compile a frame and render it, without a run.
 *
 * The Figma panel can walk a frame in milliseconds but has no way to answer the
 * only question that matters — *what will this look like?* Answering it used to
 * mean an export, a control-plane run, a compile, a fidelity gate and a preview
 * fetch. Every mistake in the pipeline was therefore discovered several services
 * away from the person who could fix it, which is exactly how a header of
 * decorative vectors shipped as a page of dashed placeholders.
 *
 * This is that loop, closed. IR in, pixels out, nothing persisted.
 *
 * It lives HERE rather than in the plugin because of the dependency graph:
 * `@fanos/compile` imports `@fanos/surface-canvas/ir`, so a plugin that
 * imported the compiler would close a cycle and `pnpm -r build` would have no
 * valid order. Surface Studio already sits downstream of both, and already owns
 * the renderer — so this is the one place the real compiler and the real
 * renderer can meet.
 *
 * The preview uses the SAME compiler and the SAME renderer as a real run, so it
 * cannot flatter the result. A preview that can lie is worse than none.
 */
import { compile } from "@fanos/compile";
import { parseFrameIRDocument } from "@fanos/surface-canvas/ir";
import { parseThemeJson } from "@fanos/tokens";

import { renderPreview } from "./preview.js";

/** A marked asset's bytes, sent inline because nothing has been uploaded yet. */
export interface PreviewAsset {
  name: string;
  bytesBase64: string;
}

export interface CompilePreviewInput {
  ir: unknown;
  /** The RAW theme file, as the plugin has it compiled in. */
  theme: unknown;
  assets?: readonly PreviewAsset[];
  width?: number;
}

/** What the panel shows beside the picture. */
export interface CompileSummary {
  nodes: number;
  byType: Record<string, number>;
  irNodes: number;
  absorbed: number;
  /** Note counts by kind — `unknown-icon`, `decorative-vector`, and so on. */
  notes: Record<string, number>;
  /** The first few messages per kind, so a count is actionable. */
  examples: Array<{ kind: string; message: string }>;
  requiredAssets: string[];
  /** Refs the tree names that no bytes were supplied for. */
  unresolvedAssets: string[];
  requiredSurfaces: string[];
}

export interface CompilePreviewResult {
  html: string;
  width: number;
  summary: CompileSummary;
}

const EXAMPLES_PER_KIND = 2;

export async function compilePreview(input: CompilePreviewInput): Promise<CompilePreviewResult> {
  const doc = parseFrameIRDocument(input.ir);

  const themes = parseThemeJson(input.theme);
  const theme = themes[0];
  if (!theme) throw new Error("the theme carries no tokens");

  const result = compile(doc, { theme });

  /**
   * Assets resolve to data URIs, which is what `ASSET_PUBLISHER=data-uri` does
   * on a real run. Deliberately the same mechanism: a preview that resolved
   * assets differently from the pipeline would be reassuring about the one
   * thing most likely to be wrong.
   */
  const supplied = new Map((input.assets ?? []).map((a) => [a.name, a.bytesBase64]));
  const assets: Record<string, string> = {};
  const unresolvedAssets: string[] = [];
  for (const required of result.requiredAssets) {
    const bytes = supplied.get(required.name);
    const leaf = required.ref.replace(/^asset\./, "");
    if (bytes) assets[leaf] = `data:image/png;base64,${bytes}`;
    else unresolvedAssets.push(required.ref);
  }

  const surfaces = {
    assets,
    surfaces: Object.fromEntries(result.requiredSurfaces.map((s) => [s.name, s.spec])),
  };

  const rendered = await renderPreview({
    tree: result.tree,
    theme: input.theme,
    surfaces,
    ...(input.width ? { width: input.width } : {}),
  });

  return {
    html: rendered.html,
    width: rendered.width,
    summary: summarize(result, unresolvedAssets),
  };
}

function summarize(
  result: ReturnType<typeof compile>,
  unresolvedAssets: string[],
): CompileSummary {
  const byType: Record<string, number> = {};
  for (const node of result.tree.nodes) byType[node.type] = (byType[node.type] ?? 0) + 1;

  const notes: Record<string, number> = {};
  const examples: Array<{ kind: string; message: string }> = [];
  const seen: Record<string, number> = {};
  for (const note of result.notes) {
    notes[note.kind] = (notes[note.kind] ?? 0) + 1;
    // A count with no example is a number nobody can act on: "9 decorative
    // vectors" does not say which layers to go and look at.
    seen[note.kind] = (seen[note.kind] ?? 0) + 1;
    if (seen[note.kind]! <= EXAMPLES_PER_KIND) {
      examples.push({ kind: note.kind, message: note.message });
    }
  }

  return {
    nodes: result.tree.nodes.length,
    byType,
    irNodes: result.stats.irNodes,
    absorbed: result.stats.absorbed,
    notes,
    examples,
    requiredAssets: result.requiredAssets.map((a) => a.ref),
    unresolvedAssets,
    requiredSurfaces: result.requiredSurfaces.map((s) => s.name),
  };
}
