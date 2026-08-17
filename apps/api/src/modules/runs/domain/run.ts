/**
 * Runs: pipeline executions, as the domain sees them.
 *
 * A run is a state machine with an ordered step trace. The rules about which
 * transitions are legal and which failures deserve a retry live here, as pure
 * functions, because they are the ones that decide whether a failed compile
 * quietly burns three attempts or fails fast.
 */
import { z } from "zod";

export const RUN_KINDS = ["compile", "conform", "render", "diff", "pipeline"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

/**
 * Everything a run needs to execute, by value.
 *
 * A run must be replayable from this alone — never by reaching back to
 * "whatever the surface points at now". That is what makes a six-month-old run
 * explicable rather than merely recorded.
 */
/**
 * A marked background the frame ships, and the artifact holding its bytes.
 *
 * Carried BY VALUE on the run, like every other input, for the reason the type
 * doc above gives: a run must be replayable from its own record. Reaching back
 * to "whatever the export points at now" would mean a re-run six months later
 * silently picking up a texture the designer has since replaced.
 *
 * The bytes themselves stay in the artifact store; this is the join the
 * compile step needs to turn `asset.texture.x` into a URL.
 */
export const RunAsset = z.object({
  name: z.string().min(1),
  artifactId: z.string().min(1),
});
export type RunAsset = z.infer<typeof RunAsset>;

const ASSET_LIMIT = 64;

export const PipelineInput = z.object({
  surfaceKey: z.string().min(1),
  irArtifact: z.string().min(1),
  themeArtifact: z.string().min(1),
  surfacesArtifact: z.string().min(1).optional(),
  /**
   * Empty by default, which is honest: a frame with no marked images has none,
   * and a caller that forgets to send them gets a run whose trace says exactly
   * which refs went unresolved rather than a page painted with a stand-in.
   */
  assets: z.array(RunAsset).max(ASSET_LIMIT).default([]),
  notes: z.string().max(2000).optional(),
});
export type PipelineInput = z.infer<typeof PipelineInput>;

export const StartRunCommand = z.object({
  kind: z.enum(RUN_KINDS).default("pipeline"),
  input: PipelineInput,
  /** Repeat submissions carrying the same key return the original run. */
  idempotencyKey: z.string().min(8).max(200).optional(),
});
export type StartRunCommand = z.infer<typeof StartRunCommand>;

export const ListRunsQuery = z.object({
  status: z.enum(RUN_STATUSES).optional(),
  surfaceKey: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListRunsQuery = z.infer<typeof ListRunsQuery>;

export interface Run {
  id: string;
  projectId: string;
  surfaceId: string | null;
  kind: RunKind;
  status: RunStatus;
  input: PipelineInput;
  idempotencyKey: string | null;
  attempt: number;
  maxAttempts: number;
  error: unknown;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  requestedBy: string | null;
}

export interface RunStep {
  id: string;
  runId: string;
  seq: number;
  name: string;
  status: StepStatus;
  outputArtifactId: string | null;
  detail: Record<string, unknown>;
  error: unknown;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface RunStepView extends Omit<RunStep, "id" | "runId" | "startedAt" | "finishedAt"> {
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface RunView
  extends Omit<Run, "queuedAt" | "startedAt" | "finishedAt" | "idempotencyKey"> {
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  steps?: RunStepView[];
}

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

/** Only an unfinished run can be claimed for execution or cancelled. */
export const CLAIMABLE: readonly RunStatus[] = ["queued", "running"];

/**
 * A run may only be settled from `running`.
 *
 * This guard is load-bearing, not defensive. The executor finishes its loop and
 * writes the outcome, but a cancel can land between the last step starting and
 * that write. Without the guard, the completing run overwrites `cancelled` with
 * `succeeded` — the operator gets a 200 from the cancel, the run finishes
 * anyway, and the acknowledgement was a lie.
 */
export const SETTLEABLE: readonly RunStatus[] = ["running"];

export function isFinished(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/**
 * Whether a failure should end the run for good rather than be retried.
 *
 * `permanent` covers 4xx-shaped failures — a malformed IR artifact will fail
 * identically on every attempt, so burning the remaining tries only delays the
 * error and muddies the trace.
 */
export function shouldGiveUp(input: {
  permanent: boolean;
  attempt: number;
  maxAttempts: number;
}): boolean {
  return input.permanent || input.attempt >= input.maxAttempts;
}

export function toRunView(run: Run): RunView {
  return {
    id: run.id,
    projectId: run.projectId,
    surfaceId: run.surfaceId,
    kind: run.kind,
    status: run.status,
    input: run.input,
    attempt: run.attempt,
    maxAttempts: run.maxAttempts,
    error: run.error,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    requestedBy: run.requestedBy,
  };
}

export function toRunStepView(step: RunStep): RunStepView {
  const started = step.startedAt?.getTime();
  const finished = step.finishedAt?.getTime();
  return {
    seq: step.seq,
    name: step.name,
    status: step.status,
    outputArtifactId: step.outputArtifactId,
    detail: step.detail,
    error: step.error,
    startedAt: step.startedAt?.toISOString() ?? null,
    finishedAt: step.finishedAt?.toISOString() ?? null,
    durationMs: started !== undefined && finished !== undefined ? finished - started : null,
  };
}
