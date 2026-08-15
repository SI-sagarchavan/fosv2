/**
 * The real toolchain: `@fanos/compile` and `@fanos/conform`, behind the port.
 *
 * This is the only file in the application that imports the pipeline packages,
 * and it exists to translate their vocabulary into the control plane's. That
 * translation is not ceremony — it is what stops a change to `ConformResult`
 * from rippling into the gate, the fidelity table and the API response shape.
 *
 * Schema failures become `AppError.unprocessable` here, which is what marks
 * them permanent so the worker does not retry a malformed artifact three times.
 */
import { compile } from "@fanos/compile";
import { conform } from "@fanos/conform";
import type { ConformIssue, ConformResult } from "@fanos/conform";
import type { FlatTree } from "@fanos/dsl";
import { parseFrameIRDocument } from "@fanos/surface-canvas/ir";
import type { FrameIRDocument, FrameIRNode } from "@fanos/surface-canvas/ir";
import { parseThemeJson } from "@fanos/tokens";
import type { NormalizedTheme, SurfaceSet } from "@fanos/tokens";

import { AppError } from "../../../kernel/errors.js";
import type { ConformOutcome, Finding } from "../../fidelity/domain/gate.js";
import type {
  CompileOutcome,
  ParsedIr,
  ParsedTheme,
  Toolchain,
} from "../domain/ports.js";

export function createFanosToolchain(): Toolchain {
  return {
    parseIr(json) {
      const doc = attempt(() => parseFrameIRDocument(json), "figma IR");
      return { handle: doc, nodeCount: countNodes(doc.root) };
    },

    parseTheme(json) {
      const themes = attempt(() => parseThemeJson(json), "token set");
      const theme = themes[0];
      if (!theme) throw AppError.unprocessable("token set artifact holds no themes");
      if (themes.length > 1) {
        throw AppError.unprocessable(
          `token set artifact holds ${themes.length} themes; upload one per artifact`,
        );
      }
      return { handle: theme, id: theme.id };
    },

    compile({ ir, theme, surfaces }) {
      const result = compile(irOf(ir), {
        theme: themeOf(theme),
        ...(surfaces !== undefined ? { surfaces: surfaces as SurfaceSet } : {}),
      });

      return {
        tree: result.tree,
        stats: result.stats,
        notes: result.notes.map((n) => ({
          kind: n.kind,
          irId: n.irId,
          nodeId: n.nodeId ?? null,
          message: n.message,
        })),
        // Only the names travel; the full surface specs stay in the compiler.
        requiredSurfaces: result.requiredSurfaces.map((s) => describeSurface(s)),
      } satisfies CompileOutcome;
    },

    conform({ tree, ir, theme }) {
      return toOutcome(conform(tree as FlatTree, irOf(ir), { theme: themeOf(theme) }));
    },
  };
}

function toOutcome(result: ConformResult): ConformOutcome {
  return {
    ok: result.ok,
    errors: result.errors.map(toFinding),
    warnings: result.warnings.map(toFinding),
    coverage: result.summary.coverage,
    geometry: result.summary.geometry,
    nodeCount: result.summary.nodeCount,
    waived: result.summary.waived,
  };
}

function toFinding(issue: ConformIssue): Finding {
  return {
    code: issue.code,
    severity: issue.severity,
    message: issue.message,
    nodeId: issue.nodeId ?? null,
  };
}

function describeSurface(surface: unknown): string {
  if (typeof surface === "string") return surface;
  const named = surface as { name?: unknown; ref?: unknown };
  if (typeof named.name === "string") return named.name;
  if (typeof named.ref === "string") return named.ref;
  return JSON.stringify(surface);
}

function irOf(parsed: ParsedIr): FrameIRDocument {
  return parsed.handle as FrameIRDocument;
}

function themeOf(parsed: ParsedTheme): NormalizedTheme {
  return parsed.handle as NormalizedTheme;
}

function countNodes(node: FrameIRNode): number {
  return 1 + (node.children ?? []).reduce((total, child) => total + countNodes(child), 0);
}

function attempt<T>(fn: () => T, what: string): T {
  try {
    return fn();
  } catch (err) {
    throw AppError.unprocessable(`${what} artifact failed schema validation`, {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}
