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

export interface CompileOutcome {
  /** The SDUI tree. Opaque to the control plane, which only stores and serves it. */
  tree: unknown;
  stats: { irNodes: number; emitted: number; absorbed: number };
  notes: CompileNote[];
  requiredSurfaces: string[];
}

export interface Toolchain {
  /** Throws `AppError.unprocessable` when the artifact fails schema validation. */
  parseIr(json: unknown): ParsedIr;
  parseTheme(json: unknown): ParsedTheme;
  compile(input: { ir: ParsedIr; theme: ParsedTheme; surfaces?: unknown }): CompileOutcome;
  conform(input: { tree: unknown; ir: ParsedIr; theme: ParsedTheme }): ConformOutcome;
}

/** What runs needs from the artifact store. Declared by the consumer. */
export interface ArtifactAccess {
  readJson(projectId: string, ref: string): Promise<unknown>;
  store(
    projectId: string,
    input: {
      kind: "dsl_tree" | "conform_report";
      bytes: Uint8Array;
      meta?: Record<string, unknown>;
      actor?: string;
    },
  ): Promise<{ id: string; digest: string }>;
}
