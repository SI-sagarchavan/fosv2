/**
 * Postgres adapter for `RunRepository`.
 *
 * The conditional updates are the concurrency control, not a nicety: `claim`
 * only moves a run out of a claimable status, so two workers racing on the same
 * job id produce exactly one winner and one `null`.
 */
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { Db } from "../../../platform/db/client.js";
import { runSteps, runs, type RunRow, type RunStepRow } from "../../../platform/db/schema.js";
import type { NewRun, RunRepository, StepOutcome } from "../domain/ports.js";
import {
  CLAIMABLE,
  SETTLEABLE,
  type PipelineInput,
  type Run,
  type RunStatus,
  type RunStep,
} from "../domain/run.js";

export class DrizzleRunRepository implements RunRepository {
  constructor(private readonly db: Db) {}

  async create(input: NewRun): Promise<Run | null> {
    // The `where` is not optional. The unique index is partial — runs without
    // an idempotency key must not collide with each other — and Postgres only
    // matches a partial index when ON CONFLICT repeats its predicate. Without
    // it: "no unique or exclusion constraint matching the ON CONFLICT
    // specification".
    const rows = await this.db
      .insert(runs)
      .values(input)
      .onConflictDoNothing({
        target: [runs.projectId, runs.idempotencyKey],
        where: sql`${runs.idempotencyKey} is not null`,
      })
      .returning();

    return rows[0] ? toRun(rows[0]) : null;
  }

  async findById(id: string): Promise<Run | null> {
    const rows = await this.db.select().from(runs).where(eq(runs.id, id)).limit(1);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async findByIdempotencyKey(projectId: string, key: string): Promise<Run | null> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.projectId, projectId), eq(runs.idempotencyKey, key)))
      .limit(1);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async list(
    projectId: string,
    opts: { status?: RunStatus; surfaceId?: string; limit: number },
  ): Promise<Run[]> {
    const filters: SQL[] = [eq(runs.projectId, projectId)];
    if (opts.status) filters.push(eq(runs.status, opts.status));
    if (opts.surfaceId) filters.push(eq(runs.surfaceId, opts.surfaceId));

    const rows = await this.db
      .select()
      .from(runs)
      .where(and(...filters))
      .orderBy(desc(runs.queuedAt))
      .limit(opts.limit);

    return rows.map(toRun);
  }

  async claim(id: string, at: Date): Promise<Run | null> {
    const rows = await this.db
      .update(runs)
      .set({
        status: "running",
        startedAt: at,
        attempt: sql`${runs.attempt} + 1`,
        error: null,
      })
      .where(and(eq(runs.id, id), inArray(runs.status, [...CLAIMABLE])))
      .returning();

    return rows[0] ? toRun(rows[0]) : null;
  }

  async finish(
    id: string,
    status: Extract<RunStatus, "succeeded" | "failed">,
    at: Date,
    error?: unknown,
  ): Promise<boolean> {
    // The status guard is the whole point — see SETTLEABLE. An unconditional
    // update here loses a cancel that landed while the last step was running.
    const rows = await this.db
      .update(runs)
      .set({ status, finishedAt: at, error: error ?? null })
      .where(and(eq(runs.id, id), inArray(runs.status, [...SETTLEABLE])))
      .returning({ id: runs.id });

    return rows.length > 0;
  }

  async cancel(id: string, at: Date): Promise<Run | null> {
    const rows = await this.db
      .update(runs)
      .set({ status: "cancelled", finishedAt: at })
      .where(and(eq(runs.id, id), inArray(runs.status, [...CLAIMABLE])))
      .returning();

    return rows[0] ? toRun(rows[0]) : null;
  }

  async planSteps(runId: string, names: readonly string[]): Promise<void> {
    if (names.length === 0) return;
    await this.db
      .insert(runSteps)
      .values(names.map((name, seq) => ({ runId, seq, name })))
      .onConflictDoNothing({ target: [runSteps.runId, runSteps.seq] });
  }

  async startStep(runId: string, seq: number, at: Date): Promise<void> {
    await this.db
      .update(runSteps)
      .set({ status: "running", startedAt: at, error: null })
      .where(and(eq(runSteps.runId, runId), eq(runSteps.seq, seq)));
  }

  async finishStep(runId: string, seq: number, outcome: StepOutcome, at: Date): Promise<void> {
    await this.db
      .update(runSteps)
      .set({
        status: outcome.status,
        finishedAt: at,
        outputArtifactId: outcome.outputArtifactId ?? null,
        detail: outcome.detail ?? {},
        error: outcome.error ?? null,
      })
      .where(and(eq(runSteps.runId, runId), eq(runSteps.seq, seq)));
  }

  async skipRemaining(runId: string, at: Date): Promise<void> {
    await this.db
      .update(runSteps)
      .set({ status: "skipped", finishedAt: at })
      .where(and(eq(runSteps.runId, runId), eq(runSteps.status, "pending")));
  }

  async listSteps(runId: string): Promise<RunStep[]> {
    const rows = await this.db
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, runId))
      .orderBy(runSteps.seq);
    return rows.map(toStep);
  }
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    projectId: row.projectId,
    surfaceId: row.surfaceId,
    kind: row.kind,
    status: row.status,
    input: row.input as PipelineInput,
    idempotencyKey: row.idempotencyKey,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    error: row.error,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    requestedBy: row.requestedBy,
  };
}

function toStep(row: RunStepRow): RunStep {
  return {
    id: row.id,
    runId: row.runId,
    seq: row.seq,
    name: row.name,
    status: row.status,
    outputArtifactId: row.outputArtifactId,
    detail: row.detail as Record<string, unknown>,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}
