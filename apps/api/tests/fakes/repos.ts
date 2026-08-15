/**
 * In-memory adapters for every driven port.
 *
 * These are the reason the refactor was worth doing: with them, the publish
 * rules, the run state machine and the retry policy are all exercisable in
 * milliseconds. They are held to the same contracts as the Postgres adapters —
 * `createVersion` allocates through the same `nextVersionNumber` the domain
 * defines, `claim` refuses a non-claimable run, `upsert` deduplicates by digest.
 *
 * What they cannot do is reproduce a lost update. Concurrency guarantees are
 * database guarantees; `tests/integration` covers those against real Postgres.
 */
import type { AuditEntry, AuditRecord, AuditSink } from "../../src/kernel/audit.js";
import type { Clock } from "../../src/kernel/clock.js";
import { AppError } from "../../src/kernel/errors.js";
import type { Artifact, ArtifactKind } from "../../src/modules/artifacts/domain/artifact.js";
import type {
  ArtifactRepository,
  BlobStore,
  NewArtifact,
} from "../../src/modules/artifacts/domain/ports.js";
import type { FidelityReport } from "../../src/modules/fidelity/domain/gate.js";
import type {
  FidelityRepository,
  NewFidelityReport,
} from "../../src/modules/fidelity/domain/ports.js";
import type { NewProject, ProjectRepository } from "../../src/modules/projects/domain/ports.js";
import type { Project } from "../../src/modules/projects/domain/project.js";
import type {
  NewRun,
  RunQueue,
  RunRepository,
  StepOutcome,
} from "../../src/modules/runs/domain/ports.js";
import {
  CLAIMABLE,
  SETTLEABLE,
  type Run,
  type RunStatus,
  type RunStep,
} from "../../src/modules/runs/domain/run.js";
import type {
  NewSurface,
  NewVersion,
  SurfaceRepository,
} from "../../src/modules/surfaces/domain/ports.js";
import {
  nextVersionNumber,
  type PublishTransition,
  type Surface,
  type SurfaceVersion,
} from "../../src/modules/surfaces/domain/surface.js";

let counter = 0;
export function id(prefix = "id"): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** A clock that only moves when a test tells it to. */
export class FixedClock implements Clock {
  constructor(private current = new Date("2026-01-01T00:00:00.000Z")) {}
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(date: Date): void {
    this.current = date;
  }
}

export class RecordingAudit implements AuditSink {
  readonly entries: AuditEntry[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }

  async list(): Promise<AuditRecord[]> {
    return [];
  }

  actions(): string[] {
    return this.entries.map((e) => e.action);
  }

  find(action: string): AuditEntry | undefined {
    return this.entries.find((e) => e.action === action);
  }
}

export class MemoryProjectRepo implements ProjectRepository {
  readonly rows: Project[] = [];

  async create(input: NewProject): Promise<Project> {
    const project: Project = {
      id: id("project"),
      ...input,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      archivedAt: null,
    };
    this.rows.push(project);
    return project;
  }

  async findBySlug(slug: string): Promise<Project | null> {
    return this.rows.find((p) => p.slug === slug) ?? null;
  }

  async findById(projectId: string): Promise<Project | null> {
    return this.rows.find((p) => p.id === projectId) ?? null;
  }

  async listActive(): Promise<Project[]> {
    return this.rows.filter((p) => !p.archivedAt);
  }
}

export class MemoryArtifactRepo implements ArtifactRepository {
  readonly rows: Artifact[] = [];

  async upsert(input: NewArtifact): Promise<{ artifact: Artifact; created: boolean }> {
    const existing = await this.findByDigest(input.projectId, input.digest);
    if (existing) return { artifact: existing, created: false };

    const artifact: Artifact = {
      id: id("artifact"),
      ...input,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    this.rows.push(artifact);
    return { artifact, created: true };
  }

  async findById(projectId: string, artifactId: string): Promise<Artifact | null> {
    return this.rows.find((a) => a.projectId === projectId && a.id === artifactId) ?? null;
  }

  async findByDigest(projectId: string, digest: string): Promise<Artifact | null> {
    return this.rows.find((a) => a.projectId === projectId && a.digest === digest) ?? null;
  }

  async list(
    projectId: string,
    opts: { kind?: ArtifactKind; limit: number },
  ): Promise<Artifact[]> {
    return this.rows
      .filter((a) => a.projectId === projectId && (!opts.kind || a.kind === opts.kind))
      .slice(0, opts.limit);
  }
}

export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array): Promise<void> {
    // Matches the fs adapter: writing the same key twice is a no-op.
    if (!this.blobs.has(key)) this.blobs.set(key, bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    const bytes = this.blobs.get(key);
    if (!bytes) throw new Error(`no blob at ${key}`);
    return bytes;
  }

  async has(key: string): Promise<boolean> {
    return this.blobs.has(key);
  }
}

export class MemorySurfaceRepo implements SurfaceRepository {
  readonly surfaces: Surface[] = [];
  readonly versions: SurfaceVersion[] = [];

  async create(input: NewSurface): Promise<Surface> {
    const surface: Surface = {
      id: id("surface"),
      ...input,
      publishedVersionId: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      archivedAt: null,
    };
    this.surfaces.push(surface);
    return surface;
  }

  async findByKey(projectId: string, key: string): Promise<Surface | null> {
    return this.surfaces.find((s) => s.projectId === projectId && s.key === key) ?? null;
  }

  async listByProject(projectId: string): Promise<Surface[]> {
    return this.surfaces.filter((s) => s.projectId === projectId);
  }

  async createVersion(input: NewVersion): Promise<SurfaceVersion> {
    const taken = this.versions
      .filter((v) => v.surfaceId === input.surfaceId)
      .map((v) => v.version);

    const version: SurfaceVersion = {
      id: id("version"),
      ...input,
      version: nextVersionNumber(taken),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      publishedAt: null,
    };
    this.versions.push(version);
    return version;
  }

  async findVersion(surfaceId: string, version: number): Promise<SurfaceVersion | null> {
    return this.versions.find((v) => v.surfaceId === surfaceId && v.version === version) ?? null;
  }

  async findVersionById(versionId: string): Promise<SurfaceVersion | null> {
    return this.versions.find((v) => v.id === versionId) ?? null;
  }

  async listVersions(surfaceId: string): Promise<SurfaceVersion[]> {
    return this.versions.filter((v) => v.surfaceId === surfaceId);
  }

  async applyPublish(
    surfaceId: string,
    transition: PublishTransition,
    at: Date,
  ): Promise<void> {
    if (transition.archive) {
      const previous = this.versions.find((v) => v.id === transition.archive);
      if (previous) previous.status = "archived";
    }
    const target = this.versions.find((v) => v.id === transition.publish);
    if (target) {
      target.status = "published";
      target.publishedAt = at;
    }
    const surface = this.surfaces.find((s) => s.id === surfaceId);
    if (surface) surface.publishedVersionId = transition.pointerTo;
  }

  async attachTree(versionId: string, dslArtifactId: string): Promise<void> {
    const version = this.versions.find((v) => v.id === versionId);
    if (version) {
      version.status = "candidate";
      version.dslArtifactId = dslArtifactId;
    }
  }
}

export class MemoryFidelityRepo implements FidelityRepository {
  readonly rows: FidelityReport[] = [];

  async record(input: NewFidelityReport): Promise<FidelityReport> {
    // Mirrors the unique (run, version) constraint: a retry replaces its own
    // verdict rather than stacking a second.
    const existing = this.rows.find(
      (r) => r.runId === input.runId && r.surfaceVersionId === input.surfaceVersionId,
    );
    if (existing) {
      Object.assign(existing, input);
      return existing;
    }

    const report: FidelityReport = {
      id: id("fidelity"),
      ...input,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    this.rows.push(report);
    return report;
  }

  async latestForVersion(surfaceVersionId: string): Promise<FidelityReport | null> {
    const matches = this.rows.filter((r) => r.surfaceVersionId === surfaceVersionId);
    return matches[matches.length - 1] ?? null;
  }

  async listForRun(runId: string): Promise<FidelityReport[]> {
    return this.rows.filter((r) => r.runId === runId);
  }
}

export class MemoryRunRepo implements RunRepository {
  readonly runs: Run[] = [];
  readonly steps: RunStep[] = [];

  async create(input: NewRun): Promise<Run | null> {
    if (input.idempotencyKey) {
      const clash = await this.findByIdempotencyKey(input.projectId, input.idempotencyKey);
      if (clash) return null;
    }

    const run: Run = {
      id: id("run"),
      ...input,
      status: "queued",
      attempt: 0,
      error: null,
      queuedAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: null,
      finishedAt: null,
    };
    this.runs.push(run);
    return run;
  }

  async findById(runId: string): Promise<Run | null> {
    return this.runs.find((r) => r.id === runId) ?? null;
  }

  async findByIdempotencyKey(projectId: string, key: string): Promise<Run | null> {
    return (
      this.runs.find((r) => r.projectId === projectId && r.idempotencyKey === key) ?? null
    );
  }

  async list(
    projectId: string,
    opts: { status?: RunStatus; surfaceId?: string; limit: number },
  ): Promise<Run[]> {
    return this.runs
      .filter(
        (r) =>
          r.projectId === projectId &&
          (!opts.status || r.status === opts.status) &&
          (!opts.surfaceId || r.surfaceId === opts.surfaceId),
      )
      .slice(0, opts.limit);
  }

  async claim(runId: string, at: Date): Promise<Run | null> {
    const run = this.runs.find((r) => r.id === runId);
    // The conditional is the concurrency control, exactly as in SQL.
    if (!run || !CLAIMABLE.includes(run.status)) return null;

    run.status = "running";
    run.startedAt = at;
    run.attempt += 1;
    run.error = null;
    return { ...run };
  }

  async finish(
    runId: string,
    status: Extract<RunStatus, "succeeded" | "failed">,
    at: Date,
    error?: unknown,
  ): Promise<boolean> {
    const run = this.runs.find((r) => r.id === runId);
    // Same guard as the SQL: settle only from `running`, so a cancel that
    // landed mid-flight is not overwritten by the completing executor.
    if (!run || !SETTLEABLE.includes(run.status)) return false;

    run.status = status;
    run.finishedAt = at;
    run.error = error ?? null;
    return true;
  }

  async cancel(runId: string, at: Date): Promise<Run | null> {
    const run = this.runs.find((r) => r.id === runId);
    if (!run || !CLAIMABLE.includes(run.status)) return null;
    run.status = "cancelled";
    run.finishedAt = at;
    return { ...run };
  }

  async planSteps(runId: string, names: readonly string[]): Promise<void> {
    names.forEach((name, seq) => {
      if (this.steps.some((s) => s.runId === runId && s.seq === seq)) return;
      this.steps.push({
        id: id("step"),
        runId,
        seq,
        name,
        status: "pending",
        outputArtifactId: null,
        detail: {},
        error: null,
        startedAt: null,
        finishedAt: null,
      });
    });
  }

  async startStep(runId: string, seq: number, at: Date): Promise<void> {
    const step = this.step(runId, seq);
    if (!step) return;
    step.status = "running";
    step.startedAt = at;
    step.error = null;
  }

  async finishStep(runId: string, seq: number, outcome: StepOutcome, at: Date): Promise<void> {
    const step = this.step(runId, seq);
    if (!step) return;
    step.status = outcome.status;
    step.finishedAt = at;
    step.outputArtifactId = outcome.outputArtifactId ?? null;
    step.detail = outcome.detail ?? {};
    step.error = outcome.error ?? null;
  }

  async skipRemaining(runId: string, at: Date): Promise<void> {
    for (const step of this.steps) {
      if (step.runId === runId && step.status === "pending") {
        step.status = "skipped";
        step.finishedAt = at;
      }
    }
  }

  async listSteps(runId: string): Promise<RunStep[]> {
    return this.steps.filter((s) => s.runId === runId).sort((a, b) => a.seq - b.seq);
  }

  private step(runId: string, seq: number): RunStep | undefined {
    return this.steps.find((s) => s.runId === runId && s.seq === seq);
  }
}

/** Records enqueues instead of talking to Redis. */
export class RecordingQueue implements RunQueue {
  readonly jobs: { runId: string; projectId: string }[] = [];

  async enqueue(job: { runId: string; projectId: string }): Promise<void> {
    this.jobs.push(job);
  }
}

export function expectDefined<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw AppError.internal(`expected ${what}`);
  return value;
}
