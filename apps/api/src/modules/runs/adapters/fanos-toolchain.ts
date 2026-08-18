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
import { analyze } from "@fanos/dsl";
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
      // The root's own box first: `breakpointHint` is derived from it, and a
      // hand-assembled document could carry one that disagrees.
      const width = doc.root.geometry.relBbox.w || doc.breakpointHint;
      return {
        handle: doc,
        nodeCount: countNodes(doc.root),
        rootNodeId: doc.rootNodeId,
        designWidth: Math.round(width),
      };
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
        // Name AND spec travel. Only the names used to, which left the pipeline
        // unable to persist a surface set — every plate the compiler folded
        // into a surface ref then resolved to nothing at render time.
        requiredSurfaces: result.requiredSurfaces.map((s) => ({ name: s.name, spec: s.spec })),
        metrics: metricsOf(result.tree),
        // No URL. The compiler names the asset; resolving that name to
        // something fetchable is the run's job, through `AssetPublisher` —
        // which is what makes one tree render against a data URI in preview and
        // an S3 object in production. This used to attach a hardcoded tenant
        // URL to every asset, so every marked background rendered as the same
        // borrowed texture.
        requiredAssets: result.requiredAssets.map((a) => ({
          name: a.name,
          ref: a.ref,
          role: a.role,
          sourceId: a.sourceId,
          targetId: a.targetId,
        })),
      } satisfies CompileOutcome;
    },

    conform({ tree, ir, theme, boxes, rootSrc, tolerance }) {
      return toOutcome(
        conform(tree as FlatTree, irOf(ir), {
          theme: themeOf(theme),
          // Passing boxes is what switches C2 on. Without them `conform`
          // reports `compared: 0` and every layout error goes unseen.
          ...(boxes ? { boxes } : {}),
          ...(rootSrc ? { rootSrc } : {}),
          ...(tolerance !== undefined ? { geometry: { tolerance } } : {}),
        }),
      );
    },
  };
}

/**
 * The DSL already computes these and nothing read them.
 *
 * Surfaced so pixel debt is a number on every run rather than an occasional
 * audit — a tree can be pixel-perfect against its frame and still be pinned
 * solid, which renders correctly at exactly one width.
 */
function metricsOf(tree: FlatTree) {
  const m = analyze(tree);
  return {
    rawValues: m.rawValueCount.total,
    rawPositions: m.rawPositionCount,
    tokenCoverage: m.tokenCoverage,
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
