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
  AssetPublisher,
  CompileOutcome,
  GeometryMeasurer,
  ParsedIr,
  ParsedTheme,
  PublishedAsset,
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
  measurer: GeometryMeasurer;
  /** Turns a marked background into a URL the renderer can fetch. */
  assets: AssetPublisher;
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
  /** The merged surface set the tree's `surface.*` refs resolve against. */
  surfaceSetArtifactId?: string;
  /** The same set by value — the measurer renders with it, not with its id. */
  surfaces?: unknown;
  /**
   * The theme as STORED, not as parsed. The renderer CLI loads a theme file and
   * normalizes it itself; handing it an already-normalized handle fails schema
   * validation with an unhelpful "Required".
   */
  themeJson?: unknown;
  /** The IR node the root came from. C2 compares boxes frame-locally. */
  rootSrc?: string;
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
    ctx.scratch.rootSrc = ctx.scratch.ir.rootNodeId;
    ctx.scratch.themeJson = themeJson;

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

    /**
     * Resolve every marked background to a real URL before the surface set is
     * written.
     *
     * This is the step that used to not exist. The compiler emits
     * `asset.texture.x` and the run is the only place that knows which artifact
     * holds those bytes — so with no resolution here, the pipeline wrote one
     * hardcoded tenant URL against every asset in every project and the
     * renderer faithfully painted it.
     *
     * `input.assets` is the join, carried by value on the run. An asset with no
     * artifact behind it stays UNRESOLVED and is reported; nothing substitutes
     * a stand-in, because a background that renders as the wrong picture is
     * worse than one that renders as nothing.
     */
    const required = compiled.requiredAssets ?? [];
    // `?? []` for runs queued before this field existed. Their stored input has
    // no `assets` key, and a re-run of one should report every ref unresolved
    // rather than throw.
    const byName = new Map((ctx.input.assets ?? []).map((a) => [a.name, a.artifactId]));
    const { published, unresolved } = await ctx.assets.publish(
      ctx.projectId,
      required.map((asset) => {
        const artifactId = byName.get(asset.name);
        return { name: asset.name, ref: asset.ref, ...(artifactId ? { artifactId } : {}) };
      }),
    );

    // A tree without its surfaces is not renderable. The compiler folds a
    // plate's fills into a surface ref rather than inlining them, so the refs
    // it emits must resolve somewhere or every background silently disappears
    // and the page renders as floating text. Persisting the merged set here is
    // what makes the run's output self-contained.
    const surfaces = mergeSurfaces(surfaceSet, compiled.requiredSurfaces, published);
    ctx.scratch.surfaces = surfaces;
    const surfacesStored = await ctx.artifacts.store(ctx.projectId, {
      kind: "surface_set",
      bytes: new TextEncoder().encode(canonicalJson(surfaces)),
      meta: {
        authored: Object.keys(surfaces.surfaces).length - compiled.requiredSurfaces.length,
        derived: compiled.requiredSurfaces.length,
        assets: published.length,
        unresolvedAssets: unresolved.length,
        surfaceKey: ctx.input.surfaceKey,
      },
      actor: ctx.actor,
    });
    ctx.scratch.surfaceSetArtifactId = surfacesStored.id;

    return {
      outputArtifactId: stored.id,
      detail: {
        stats: compiled.stats,
        digest: stored.digest,
        // The compiler's "I had to guess" list. Worth surfacing in the trace
        // even when the gate passes.
        notes: compiled.notes.slice(0, NOTE_LIMIT),
        truncatedNotes: Math.max(0, compiled.notes.length - NOTE_LIMIT),
        // Names only in the trace — the specs can be large, and they are in the
        // artifact for anything that needs to render them.
        requiredSurfaces: compiled.requiredSurfaces.map((s) => s.name),
        requiredAssets: required.map((a) => a.ref),
        /**
         * Named, not counted. An asset the run could not resolve renders as
         * nothing, and "3 backgrounds missing" sends someone hunting through a
         * tree — the refs say which marks to go and look at.
         */
        unresolvedAssets: unresolved,
        surfaceSetArtifact: surfacesStored.id,
        // Pixel debt, on every run and beside the fidelity numbers rather than
        // behind them. A tree can match its frame exactly and still be pinned
        // solid — correct at one width, wrong at every other — so drift alone
        // is a number that can be bought by making the tree less responsive.
        metrics: compiled.metrics,
      },
    };
  },
};

/**
 * The theme's authored surfaces, with the compiler's derived ones layered on.
 *
 * Derived wins on a name clash: it was produced from this frame, and a stale
 * authored entry of the same name would render the wrong plate.
 *
 * `assets` maps each `asset.*` ref to the URL the publisher resolved. A ref
 * with no entry is simply absent, and `emitCss` renders that layer as `none` —
 * which is the correct outcome for a background nobody can find. It used to
 * fall back to a hardcoded tenant URL, so every unresolved asset on every
 * project rendered as the same borrowed texture.
 *
 * The RESOLVED url wins over an authored one. The authored map is tenant
 * configuration; the published one was produced from the bytes this very run
 * ingested, and when they disagree the run's own bytes are the truth.
 */
function mergeSurfaces(
  base: unknown,
  derived: readonly { name: string; spec: unknown }[],
  published: readonly PublishedAsset[] = [],
): { assets: Record<string, unknown>; surfaces: Record<string, unknown> } {
  const source = (base ?? {}) as {
    assets?: Record<string, unknown>;
    surfaces?: Record<string, unknown>;
  };

  const mergedAssets: Record<string, unknown> = { ...(source.assets ?? {}) };
  for (const asset of published) {
    // Bare key the token registry looks up: `asset.texture.x` -> `texture.x`.
    const leaf = asset.ref.startsWith("asset.") ? asset.ref.slice("asset.".length) : asset.ref;
    mergedAssets[leaf] = asset.url;
  }

  return {
    assets: mergedAssets,
    surfaces: {
      ...(source.surfaces ?? {}),
      ...Object.fromEntries(derived.map((s) => [s.name, s.spec])),
    },
  };
}

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

    /**
     * Measure before judging.
     *
     * C2 compares every node's rendered box against the IR, and it is the only
     * check that can see a layout error. Coverage checks ask "is this node
     * represented"; a 552x552 grey square where a 552x1 rule belongs is
     * represented, correctly themed, and completely wrong. Without boxes this
     * gate passed that page for weeks.
     */
    const measured = await ctx.measurer.measure({
      tree: compiled.tree,
      theme: ctx.scratch.themeJson,
      ...(ctx.scratch.surfaces !== undefined ? { surfaces: ctx.scratch.surfaces } : {}),
      // The frame's own width. The CLI otherwise defaults to a 534px card, and
      // every box in a 1170px page would then disagree with the IR by design.
      ...(ir.designWidth > 0 ? { width: ir.designWidth } : {}),
    });

    const outcome = ctx.toolchain.conform({
      tree: compiled.tree,
      ir,
      theme,
      ...(measured.measured ? { boxes: measured.boxes } : {}),
      rootSrc: ctx.scratch.rootSrc ?? "",
    });

    const stored = await ctx.artifacts.store(ctx.projectId, {
      kind: "conform_report",
      bytes: new TextEncoder().encode(
        canonicalJson({
          ...outcome,
          // Travels with the report: a reader must be able to tell "no geometry
          // errors" from "no geometry checked".
          measurement: measured.measured
            ? { measured: true, boxes: measured.boxes.length }
            : { measured: false, reason: measured.reason },
        }),
      ),
      meta: {
        ok: outcome.ok,
        errors: outcome.errors.length,
        warnings: outcome.warnings.length,
        geometryMeasured: measured.measured,
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
        // `measured` is deliberately adjacent to the numbers it qualifies.
        // `compared: 0` on its own reads as "nothing wrong".
        geometry: {
          ...outcome.geometry,
          measured: measured.measured,
          ...(measured.measured ? {} : { reason: measured.reason }),
        },
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
