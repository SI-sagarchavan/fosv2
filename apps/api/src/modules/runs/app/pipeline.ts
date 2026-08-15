/**
 * The pipeline steps and the plan for each run kind.
 *
 * Every step is a function of (input artifacts) -> (output artifact + detail),
 * reached entirely through ports. Nothing here reads mutable surface state, so
 * re-running a run months later against the same input artifacts produces the
 * same bytes — that property is why artifacts are content-addressed at all.
 *
 * Because the compiler sits behind `Toolchain`, this whole file is exercisable
 * with a fake: the tests drive cancel-mid-run and step-failure paths that would
 * otherwise need a deliberately broken Figma export to provoke.
 */
import { AppError } from "../../../kernel/errors.js";
import { canonicalJson } from "../../../kernel/hash.js";
import type { ConformOutcome } from "../../fidelity/domain/gate.js";
import type {
  ArtifactAccess,
  CompileOutcome,
  ParsedIr,
  ParsedTheme,
  Toolchain,
} from "../domain/ports.js";
import type { PipelineInput, RunKind } from "../domain/run.js";

export interface VersionWriter {
  createVersion(
    projectId: string,
    surfaceKey: string,
    input: {
      dslArtifact: string;
      irArtifact: string;
      sourceRunId: string;
      /** A run-produced version arrives with a tree already attached, so it is
       * a candidate, not a draft. Drafts are for versions authored by hand. */
      status: "candidate";
      notes?: string;
    },
    actor: string,
  ): Promise<{ id: string; version: number }>;
}

export interface GateWriter {
  record(input: {
    runId: string;
    surfaceVersionId: string;
    outcome: ConformOutcome;
    reportArtifactId?: string;
  }): Promise<unknown>;
}

export interface StepContext {
  runId: string;
  projectId: string;
  input: PipelineInput;
  actor: string;
  artifacts: ArtifactAccess;
  toolchain: Toolchain;
  versions: VersionWriter;
  gate: GateWriter;
  scratch: Scratch;
}

export interface Scratch {
  ir?: ParsedIr;
  theme?: ParsedTheme;
  surfaceSet?: unknown;
  compiled?: CompileOutcome;
  dslArtifactId?: string;
  surfaceVersionId?: string;
  surfaceVersionNumber?: number;
}

export interface StepResult {
  outputArtifactId?: string;
  detail?: Record<string, unknown>;
}

export interface PipelineStep {
  name: string;
  run(ctx: StepContext): Promise<StepResult>;
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

/** Pull and parse every input before anything expensive runs. */
const loadInputs: PipelineStep = {
  name: "load-inputs",
  async run(ctx) {
    const [irJson, themeJson] = await Promise.all([
      ctx.artifacts.readJson(ctx.projectId, ctx.input.irArtifact),
      ctx.artifacts.readJson(ctx.projectId, ctx.input.themeArtifact),
    ]);

    ctx.scratch.ir = ctx.toolchain.parseIr(irJson);
    ctx.scratch.theme = ctx.toolchain.parseTheme(themeJson);

    if (ctx.input.surfacesArtifact) {
      ctx.scratch.surfaceSet = await ctx.artifacts.readJson(
        ctx.projectId,
        ctx.input.surfacesArtifact,
      );
    }

    return {
      detail: {
        themeId: ctx.scratch.theme.id,
        irNodeCount: ctx.scratch.ir.nodeCount,
        surfacesProvided: ctx.scratch.surfaceSet !== undefined,
      },
    };
  },
};

/** Figma IR -> SDUI tree. Deterministic; no model in the loop. */
const compile: PipelineStep = {
  name: "compile",
  async run(ctx) {
    const { ir, theme, surfaceSet } = ctx.scratch;
    if (!ir || !theme) throw AppError.internal("compile ran before load-inputs");

    const compiled = ctx.toolchain.compile({
      ir,
      theme,
      ...(surfaceSet !== undefined ? { surfaces: surfaceSet } : {}),
    });
    ctx.scratch.compiled = compiled;

    const stored = await ctx.artifacts.store(ctx.projectId, {
      kind: "dsl_tree",
      bytes: new TextEncoder().encode(canonicalJson(compiled.tree)),
      meta: {
        stats: compiled.stats,
        noteCount: compiled.notes.length,
        requiredSurfaces: compiled.requiredSurfaces.length,
        surfaceKey: ctx.input.surfaceKey,
      },
      actor: ctx.actor,
    });
    ctx.scratch.dslArtifactId = stored.id;

    return {
      outputArtifactId: stored.id,
      detail: {
        stats: compiled.stats,
        digest: stored.digest,
        // The compiler's "I had to guess" list. Worth surfacing in the trace
        // even when the gate passes.
        notes: compiled.notes.slice(0, NOTE_LIMIT),
        truncatedNotes: Math.max(0, compiled.notes.length - NOTE_LIMIT),
        requiredSurfaces: compiled.requiredSurfaces,
      },
    };
  },
};

const NOTE_LIMIT = 50;

/** Attach the compiled tree to a new surface version, as a candidate. */
const version: PipelineStep = {
  name: "version",
  async run(ctx) {
    const { dslArtifactId } = ctx.scratch;
    if (!dslArtifactId) throw AppError.internal("version ran before compile");

    const created = await ctx.versions.createVersion(
      ctx.projectId,
      ctx.input.surfaceKey,
      {
        dslArtifact: dslArtifactId,
        irArtifact: ctx.input.irArtifact,
        sourceRunId: ctx.runId,
        status: "candidate",
        ...(ctx.input.notes ? { notes: ctx.input.notes } : {}),
      },
      ctx.actor,
    );

    ctx.scratch.surfaceVersionId = created.id;
    ctx.scratch.surfaceVersionNumber = created.version;

    return { detail: { version: created.version, surfaceVersionId: created.id } };
  },
};

/**
 * The fidelity gate.
 *
 * A failing gate does NOT fail the run — the run succeeded at producing a
 * verdict. The verdict is what blocks publishing. Conflating the two would mean
 * a retry storm every time a designer ships something off-spec.
 */
const conform: PipelineStep = {
  name: "conform",
  async run(ctx) {
    const { ir, theme, compiled, surfaceVersionId } = ctx.scratch;
    if (!ir || !theme || !compiled) throw AppError.internal("conform ran before compile");
    if (!surfaceVersionId) throw AppError.internal("conform ran before version");

    const outcome = ctx.toolchain.conform({ tree: compiled.tree, ir, theme });

    const stored = await ctx.artifacts.store(ctx.projectId, {
      kind: "conform_report",
      bytes: new TextEncoder().encode(canonicalJson(outcome)),
      meta: {
        ok: outcome.ok,
        errors: outcome.errors.length,
        warnings: outcome.warnings.length,
      },
      actor: ctx.actor,
    });

    await ctx.gate.record({
      runId: ctx.runId,
      surfaceVersionId,
      outcome,
      reportArtifactId: stored.id,
    });

    return {
      outputArtifactId: stored.id,
      detail: {
        ok: outcome.ok,
        errors: outcome.errors.length,
        warnings: outcome.warnings.length,
        waived: outcome.waived,
        coverage: outcome.coverage,
        geometry: outcome.geometry,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// plans
// ---------------------------------------------------------------------------

const PLANS: Record<RunKind, readonly PipelineStep[]> = {
  compile: [loadInputs, compile, version],
  conform: [loadInputs, compile, version, conform],
  pipeline: [loadInputs, compile, version, conform],
  // Both need @fanos/renderer's Playwright harness out-of-process. Planned as
  // empty so a request fails loudly instead of succeeding at nothing.
  render: [],
  diff: [],
};

export function planFor(kind: RunKind): readonly PipelineStep[] {
  const plan = PLANS[kind];
  if (plan.length === 0) {
    throw AppError.unprocessable(`run kind "${kind}" is not implemented yet`);
  }
  return plan;
}

export function stepNames(kind: RunKind): string[] {
  return planFor(kind).map((s) => s.name);
}
