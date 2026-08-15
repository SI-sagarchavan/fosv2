/**
 * Run use cases: the command side (start, cancel), the read side, and the
 * executor the worker drives.
 *
 * The split between `start` and `execute` is the load-bearing one. `start`
 * writes a row and enqueues an id — fast, transactional, safe to retry.
 * `execute` happens later in another process and trusts nothing but the run id,
 * so a duplicated or stale job is harmless.
 */
import type { AuditSink } from "../../../kernel/audit.js";
import type { Clock } from "../../../kernel/clock.js";
import { AppError, isPermanent, serialiseError } from "../../../kernel/errors.js";
import type {
  ArtifactAccess,
  RunQueue,
  RunRepository,
  Toolchain,
} from "../domain/ports.js";
import {
  shouldGiveUp,
  toRunStepView,
  toRunView,
  type ListRunsQuery,
  type RunView,
  type StartRunCommand,
} from "../domain/run.js";
import { planFor, stepNames, type GateWriter, type Scratch, type StepContext, type VersionWriter } from "./pipeline.js";

/** Thrown when a cancel lands mid-run. Not an error condition — a decision. */
export class RunCancelled extends Error {
  constructor(runId: string) {
    super(`run ${runId} was cancelled`);
    this.name = "RunCancelled";
  }
}

export interface RunLogger {
  info: (obj: unknown, msg: string) => void;
  error: (obj: unknown, msg: string) => void;
}

/** What runs needs from surfaces: resolve a key, and mint a version. */
export interface SurfaceAccess extends VersionWriter {
  require(projectId: string, key: string): Promise<{ id: string }>;
}

export interface RunServiceDeps {
  repo: RunRepository;
  queue: RunQueue;
  artifacts: ArtifactAccess;
  surfaces: SurfaceAccess;
  toolchain: Toolchain;
  gate: GateWriter;
  audit: AuditSink;
  clock: Clock;
  maxAttempts: number;
  logger?: RunLogger;
}

const NOOP_LOGGER: RunLogger = { info: () => {}, error: () => {} };

export class RunService {
  private readonly logger: RunLogger;

  constructor(private readonly deps: RunServiceDeps) {
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  // --- command side --------------------------------------------------------

  async start(projectId: string, command: StartRunCommand, actor: string): Promise<RunView> {
    // Validate the plan exists before writing anything.
    const names = stepNames(command.kind);

    // The surface must exist up front. Discovering a typo inside the worker
    // turns a 404 into a failed run, which is a much worse way to learn.
    const surface = await this.deps.surfaces.require(projectId, command.input.surfaceKey);

    const created = await this.deps.repo.create({
      projectId,
      surfaceId: surface.id,
      kind: command.kind,
      input: command.input,
      idempotencyKey: command.idempotencyKey ?? null,
      maxAttempts: this.deps.maxAttempts,
      requestedBy: actor,
    });

    if (!created) {
      // An identical key already ran. Hand back the original rather than
      // starting a second one.
      const existing = command.idempotencyKey
        ? await this.deps.repo.findByIdempotencyKey(projectId, command.idempotencyKey)
        : null;
      if (!existing) throw AppError.internal("run create conflicted but no run was found");
      return toRunView(existing);
    }

    await this.deps.repo.planSteps(created.id, names);
    await this.deps.queue.enqueue(
      { runId: created.id, projectId },
      { attempts: this.deps.maxAttempts },
    );

    await this.deps.audit.record({
      projectId,
      actor,
      action: "run.started",
      subjectType: "run",
      subjectId: created.id,
      diff: { kind: command.kind, surfaceKey: command.input.surfaceKey },
    });

    return toRunView(created);
  }

  async cancel(projectId: string, runId: string, actor: string): Promise<RunView> {
    const run = await this.require(projectId, runId);
    const now = this.deps.clock.now();

    const cancelled = await this.deps.repo.cancel(run.id, now);
    if (!cancelled) throw AppError.conflict(`run ${runId} already finished as "${run.status}"`);
    await this.deps.repo.skipRemaining(run.id, now);

    await this.deps.audit.record({
      projectId,
      actor,
      action: "run.cancelled",
      subjectType: "run",
      subjectId: run.id,
      diff: { from: run.status },
    });

    return toRunView(cancelled);
  }

  // --- read side -----------------------------------------------------------

  async get(projectId: string, runId: string): Promise<RunView> {
    const run = await this.require(projectId, runId);
    const steps = await this.deps.repo.listSteps(run.id);
    return { ...toRunView(run), steps: steps.map(toRunStepView) };
  }

  async list(projectId: string, query: ListRunsQuery): Promise<RunView[]> {
    const surfaceId = query.surfaceKey
      ? (await this.deps.surfaces.require(projectId, query.surfaceKey)).id
      : undefined;

    const runs = await this.deps.repo.list(projectId, {
      ...(query.status ? { status: query.status } : {}),
      ...(surfaceId ? { surfaceId } : {}),
      limit: query.limit,
    });
    return runs.map(toRunView);
  }

  // --- execution -----------------------------------------------------------

  /**
   * Runs the plan step by step, recording each outcome as it goes.
   *
   * Steps are not individually retried: a failed step fails the run and the
   * queue retries the whole thing. That is the right call while steps are cheap
   * and deterministic — partial resume is a lot of machinery to save seconds of
   * CPU, and it reintroduces the half-applied state this design avoids.
   */
  async execute(runId: string): Promise<void> {
    const claimed = await this.deps.repo.claim(runId, this.deps.clock.now());
    if (!claimed) {
      this.logger.info({ runId }, "run not claimable; skipping");
      return;
    }

    const plan = planFor(claimed.kind);
    const scratch: Scratch = {};

    const ctx: StepContext = {
      runId: claimed.id,
      projectId: claimed.projectId,
      input: claimed.input,
      actor: claimed.requestedBy ?? "system",
      artifacts: this.deps.artifacts,
      toolchain: this.deps.toolchain,
      versions: this.deps.surfaces,
      gate: this.deps.gate,
      scratch,
    };

    try {
      for (const [seq, step] of plan.entries()) {
        await this.assertNotCancelled(claimed.id);
        await this.deps.repo.startStep(claimed.id, seq, this.deps.clock.now());

        try {
          const result = await step.run(ctx);
          await this.deps.repo.finishStep(
            claimed.id,
            seq,
            {
              status: "succeeded",
              outputArtifactId: result.outputArtifactId ?? null,
              detail: result.detail ?? {},
            },
            this.deps.clock.now(),
          );
        } catch (err) {
          await this.deps.repo.finishStep(
            claimed.id,
            seq,
            { status: "failed", error: serialiseError(err) },
            this.deps.clock.now(),
          );
          throw err;
        }
      }

      const settled = await this.deps.repo.finish(claimed.id, "succeeded", this.deps.clock.now());
      if (!settled) {
        // A cancel landed while the last step was running. It wins: the
        // operator asked to stop and we told them we had. The step trace still
        // records what completed before the cancel took effect.
        this.logger.info({ runId: claimed.id }, "run completed but was cancelled; keeping cancelled");
        return;
      }
      this.logger.info({ runId: claimed.id, kind: claimed.kind }, "run succeeded");
    } catch (err) {
      await this.deps.repo.skipRemaining(claimed.id, this.deps.clock.now());

      if (err instanceof RunCancelled) {
        this.logger.info({ runId: claimed.id }, "run cancelled mid-flight");
        return;
      }

      const giveUp = shouldGiveUp({
        permanent: isPermanent(err),
        attempt: claimed.attempt,
        maxAttempts: claimed.maxAttempts,
      });

      if (giveUp) {
        await this.deps.repo.finish(claimed.id, "failed", this.deps.clock.now(), serialiseError(err));
      }
      this.logger.error({ runId: claimed.id, err, giveUp }, "run failed");

      // Rethrow so the queue decides on the retry. A run that is out of
      // attempts is already marked failed, so a retry finds nothing to claim.
      throw err;
    }
  }

  private async assertNotCancelled(runId: string): Promise<void> {
    const fresh = await this.deps.repo.findById(runId);
    if (fresh?.status === "cancelled") throw new RunCancelled(runId);
  }

  private async require(projectId: string, runId: string) {
    const run = await this.deps.repo.findById(runId);
    if (!run || run.projectId !== projectId) throw AppError.notFound("run", runId);
    return run;
  }
}
