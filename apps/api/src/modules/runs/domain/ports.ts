/**
 * Driven ports for runs.
 *
 * The `Toolchain` port is the one that changes how this codebase feels.
 * `@fanos/compile` and `@fanos/conform` used to be imported directly into the
 * pipeline, which meant the run state machine could not be exercised without
 * running a real compiler over a real Figma export. Behind an interface, the
 * whole retry/cancel/step-trace machine can be driven by a fake that returns
 * whatever outcome the test needs — including the failures that are awkward to
 * provoke for real.
 */
import type { ConformOutcome } from "../../fidelity/domain/gate.js";
import type { PipelineInput, Run, RunKind, RunStatus, RunStep, StepStatus } from "./run.js";

export interface NewRun {
  projectId: string;
  surfaceId: string | null;
  kind: RunKind;
  input: PipelineInput;
  idempotencyKey: string | null;
  maxAttempts: number;
  requestedBy: string | null;
}

export interface StepOutcome {
  status: Extract<StepStatus, "succeeded" | "failed" | "skipped">;
  outputArtifactId?: string | null;
  detail?: Record<string, unknown>;
  error?: unknown;
}

export interface RunRepository {
  /** Returns null when an identical idempotency key already produced a run. */
  create(input: NewRun): Promise<Run | null>;
  findById(id: string): Promise<Run | null>;
  findByIdempotencyKey(projectId: string, key: string): Promise<Run | null>;
  list(
    projectId: string,
    opts: { status?: RunStatus; surfaceId?: string; limit: number },
  ): Promise<Run[]>;

  /**
   * Move a run to `running` and increment its attempt, but only from a
   * claimable status. Returns null when another worker got there first or the
   * run was cancelled between enqueue and pickup — that conditional update is
   * the concurrency control, not an optimisation.
   */
  claim(id: string, at: Date): Promise<Run | null>;

  /**
   * Settle a run, but only from `running`. Returns false when the run was
   * already settled — in practice, cancelled underneath the executor — so the
   * caller can tell "I finished it" from "someone else got there first".
   */
  finish(
    id: string,
    status: Extract<RunStatus, "succeeded" | "failed">,
    at: Date,
    error?: unknown,
  ): Promise<boolean>;
  cancel(id: string, at: Date): Promise<Run | null>;

  planSteps(runId: string, names: readonly string[]): Promise<void>;
  startStep(runId: string, seq: number, at: Date): Promise<void>;
  finishStep(runId: string, seq: number, outcome: StepOutcome, at: Date): Promise<void>;
  /** Leaves no dangling `pending` behind a failed or cancelled run. */
  skipRemaining(runId: string, at: Date): Promise<void>;
  listSteps(runId: string): Promise<RunStep[]>;
}

export interface RunQueue {
  enqueue(job: { runId: string; projectId: string }, opts?: { attempts?: number }): Promise<void>;
}

// ---------------------------------------------------------------------------
// the toolchain port
// ---------------------------------------------------------------------------

/** Opaque handles. The control plane carries them; only the adapter reads them. */
export interface ParsedIr {
  readonly handle: unknown;
  readonly nodeCount: number;
  /**
   * The frame's root node id. Surfaced rather than dug out of `handle` because
   * the geometry check needs it to compare frame-locally, and `handle` is
   * deliberately opaque to everything above the adapter.
   */
  readonly rootNodeId: string;
  /**
   * The width the frame was drawn at, and therefore the width its boxes were
   * measured at.
   *
   * An IR fact, not a DSL one. The compiler used to leave it on the tree's root
   * as a raw pixel width, and reading it back from there was fine right up until
   * the compiler stopped pinning full-width bands — at which point the gate
   * would have measured a 1366px design at the renderer's default and reported
   * every node in it as misplaced.
   */
  readonly designWidth: number;
}

export interface ParsedTheme {
  readonly handle: unknown;
  readonly id: string;
}

export interface CompileNote {
  kind: string;
  irId: string;
  nodeId: string | null;
  message: string;
}

/**
 * A surface the frame needs and the theme has not authored.
 *
 * `spec` is the load-bearing half and was previously dropped on the floor: the
 * compiler folds a plate's fills into a surface ref, so a tree that names
 * surfaces nobody can resolve renders as text on a blank page. Carrying the
 * spec is what lets the run persist a usable surface set.
 */
export interface RequiredSurface {
  name: string;
  spec: unknown;
}

export interface RequiredAsset {
  name: string;
  ref: string;
  role: "background";
  sourceId: string;
  targetId: string;
}

/**
 * Tree quality, as opposed to fidelity.
 *
 * Deliberately reported next to the geometry drift, because the two pull
 * against each other: any layout error can be driven to zero by pinning raw
 * pixels, which buys a green gate by making the tree non-responsive. Neither
 * number means anything alone.
 */
export interface ResponsivenessMetrics {
  /** Every Raw<T> in the tree — a value with no token and no intrinsic rule. */
  rawValues: number;
  /**
   * Raw inside `place.offset`. Reported on its own, never folded into
   * coverage: a coordinate has no token to bind to, so counting it would cap
   * the ratio below 1 forever and measure how many Overlays a design has
   * rather than how well it is tokenised. Different problem, different owner —
   * this one is fixed by auto-layout in Figma, not by binding variables.
   */
  rawPositions: number;
  /**
   * tokenised / (tokenised + raw), over values that COULD be a token.
   * 1.0 is fully expressed in design tokens.
   */
  tokenCoverage: number;
}

export interface CompileOutcome {
  /** The SDUI tree. Opaque to the control plane, which only stores and serves it. */
  tree: unknown;
  stats: { irNodes: number; emitted: number; absorbed: number };
  notes: CompileNote[];
  requiredSurfaces: RequiredSurface[];
  metrics: ResponsivenessMetrics;
  requiredAssets: RequiredAsset[];
}

export interface Toolchain {
  /** Throws `AppError.unprocessable` when the artifact fails schema validation. */
  parseIr(json: unknown): ParsedIr;
  parseTheme(json: unknown): ParsedTheme;
  compile(input: { ir: ParsedIr; theme: ParsedTheme; surfaces?: unknown }): CompileOutcome;
  conform(input: {
    tree: unknown;
    ir: ParsedIr;
    theme: ParsedTheme;
    /**
     * Measured boxes. Without them the geometry check (C2) does not run, and
     * `geometry.compared` comes back 0 — which is not a pass, it is silence.
     */
    boxes?: readonly MeasuredBox[];
    /** The IR node the tree's root came from; C2 compares frame-locally. */
    rootSrc?: string;
    tolerance?: number;
  }): ConformOutcome;
}

/** One element's box, relative to the rendered root. */
export interface MeasuredBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Why a measurement did not happen. Always recorded, never swallowed.
 *
 * A gate that quietly reports `compared: 0` is worse than one that fails: the
 * fixtures page rendered four times too tall through a run that said "4 errors,
 * 46 warnings" and never mentioned it had checked no geometry at all.
 */
export type MeasureOutcome =
  | { measured: true; boxes: MeasuredBox[] }
  | { measured: false; reason: string };

/**
 * Headless render + measure, OUT OF PROCESS.
 *
 * The control plane must not grow a browser automation dependency: the API and
 * the worker both import this port, and the adapter behind it spawns the
 * renderer's CLI rather than linking its Playwright harness. That boundary is
 * why `@fanos/renderer/harness` is a separate entry point in the first place.
 */
export interface GeometryMeasurer {
  measure(input: {
    tree: unknown;
    theme: unknown;
    surfaces?: unknown;
    /** Page width to render at. Defaults to the tree root's own width. */
    width?: number;
  }): Promise<MeasureOutcome>;
}

/** What runs needs from the artifact store. Declared by the consumer. */
export interface ArtifactAccess {
  readJson(projectId: string, ref: string): Promise<unknown>;
  /** Raw bytes plus media type — how a marked background becomes a URL. */
  readBytes(projectId: string, ref: string): Promise<{ bytes: Uint8Array; mediaType: string }>;
  store(
    projectId: string,
    input: {
      kind: "dsl_tree" | "conform_report" | "surface_set";
      bytes: Uint8Array;
      meta?: Record<string, unknown>;
      actor?: string;
    },
  ): Promise<{ id: string; digest: string }>;
}

// ---------------------------------------------------------------------------
// the asset publisher port
// ---------------------------------------------------------------------------

/** A marked background the compiled tree references, and where its bytes are. */
export interface PublishableAsset {
  /** The bare token key: `texture.tickets_plate`. */
  name: string;
  /** The full ref: `asset.texture.tickets_plate`. */
  ref: string;
  /** The artifact holding the PNG the designer marked, if the run was given one. */
  artifactId?: string;
}

export interface PublishedAsset {
  ref: string;
  /** What the renderer fetches. A `data:` URI, an API URL, or an S3 URL. */
  url: string;
}

/**
 * Turn a marked background into something the renderer can fetch.
 *
 * This is the seam the whole asset story pivots on, and it exists because the
 * answer is genuinely environment-specific: a preview iframe wants bytes it can
 * paint with no credentials, the pixel harness wants no network at all, and
 * production wants an object-storage URL on a CDN. One tree serves all three
 * because the tree carries `asset.texture.x` and never a URL.
 *
 * What it replaced was a constant. Every marked asset in every project resolved
 * to one hardcoded tenant URL, so a designer could mark any image they liked and
 * the page would render somebody else's listing pattern.
 *
 * An asset this cannot resolve must come back UNRESOLVED rather than pointed at
 * a stand-in. A missing background that renders as nothing is a bug someone
 * fixes; a missing background that renders as the wrong picture is a bug that
 * ships.
 */
export interface AssetPublisher {
  publish(
    projectId: string,
    assets: readonly PublishableAsset[],
  ): Promise<{ published: PublishedAsset[]; unresolved: string[] }>;
}
