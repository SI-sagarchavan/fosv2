/**
 * Surface use cases.
 *
 * Notice what this file does NOT contain: any SQL, any decision. It resolves
 * references, asks the domain what is allowed, and applies the answer. Every
 * rule worth arguing about lives in `domain/surface.ts` where it can be tested
 * without a database — which is the entire point of the shape.
 */
import type { AuditSink } from "../../../kernel/audit.js";
import type { Clock } from "../../../kernel/clock.js";
import { AppError } from "../../../kernel/errors.js";
import type { ArtifactLookup, GateLookup, SurfaceRepository } from "../domain/ports.js";
import {
  canPublish,
  publishTransition,
  type CreateSurfaceCommand,
  type CreateVersionCommand,
  type LiveSurfaceView,
  type PublishCommand,
  type Surface,
  type SurfaceVersion,
  type SurfaceVersionView,
  type SurfaceView,
  type VersionStatus,
} from "../domain/surface.js";

export interface SurfaceServiceDeps {
  repo: SurfaceRepository;
  artifacts: ArtifactLookup;
  gate: GateLookup;
  audit: AuditSink;
  clock: Clock;
}

export class SurfaceService {
  constructor(private readonly deps: SurfaceServiceDeps) {}

  async create(
    projectId: string,
    command: CreateSurfaceCommand,
    actor: string,
  ): Promise<SurfaceView> {
    const clash = await this.deps.repo.findByKey(projectId, command.key);
    if (clash) throw AppError.conflict(`surface "${command.key}" already exists`);

    const surface = await this.deps.repo.create({
      projectId,
      key: command.key,
      name: command.name,
    });

    await this.deps.audit.record({
      projectId,
      actor,
      action: "surface.created",
      subjectType: "surface",
      subjectId: surface.id,
      diff: { key: surface.key, name: surface.name },
    });

    return toView(surface, null);
  }

  async list(projectId: string): Promise<SurfaceView[]> {
    const surfaces = await this.deps.repo.listByProject(projectId);
    return Promise.all(surfaces.map((s) => this.withPublishedNumber(s)));
  }

  async get(projectId: string, key: string): Promise<SurfaceView> {
    return this.withPublishedNumber(await this.require(projectId, key));
  }

  async createVersion(
    projectId: string,
    key: string,
    command: CreateVersionCommand & {
      sourceRunId?: string;
      status?: Extract<VersionStatus, "draft" | "candidate">;
    },
    actor: string,
  ): Promise<SurfaceVersionView> {
    const surface = await this.require(projectId, key);

    // Resolve refs before touching the repository: a 404 here should not open a
    // transaction, let alone hold a row lock while it fails.
    const dslArtifactId = command.dslArtifact
      ? await this.deps.artifacts.resolveId(projectId, command.dslArtifact)
      : null;
    const irArtifactId = command.irArtifact
      ? await this.deps.artifacts.resolveId(projectId, command.irArtifact)
      : null;

    const created = await this.deps.repo.createVersion({
      surfaceId: surface.id,
      status: command.status ?? "draft",
      dslArtifactId,
      irArtifactId,
      sourceRunId: command.sourceRunId ?? null,
      notes: command.notes ?? null,
      createdBy: actor,
    });

    await this.deps.audit.record({
      projectId,
      actor,
      action: "surface.version_created",
      subjectType: "surface_version",
      subjectId: created.id,
      diff: { surface: key, version: created.version, sourceRunId: created.sourceRunId },
    });

    return toVersionView(created);
  }

  async listVersions(projectId: string, key: string): Promise<SurfaceVersionView[]> {
    const surface = await this.require(projectId, key);
    const versions = await this.deps.repo.listVersions(surface.id);
    return [...versions].sort((a, b) => b.version - a.version).map(toVersionView);
  }

  async publish(
    projectId: string,
    key: string,
    command: PublishCommand,
    actor: string,
  ): Promise<SurfaceView> {
    const surface = await this.require(projectId, key);
    const target = await this.requireVersion(surface.id, command.version);
    const gate = await this.deps.gate.latestForVersion(target.id);

    const decision = canPublish(target, gate, {
      overrideFidelityGate: command.overrideFidelityGate,
    });

    if (!decision.allowed) {
      const { refusal } = decision;
      throw AppError.unprocessable(
        refusal.message,
        refusal.reason === "gate-failed" ? { score: refusal.score } : undefined,
      );
    }

    const transition = publishTransition(surface, target);
    await this.deps.repo.applyPublish(surface.id, transition, this.deps.clock.now());

    await this.deps.audit.record({
      projectId,
      actor,
      action: "surface.published",
      subjectType: "surface",
      subjectId: surface.id,
      diff: {
        key,
        to: target.version,
        archivedVersionId: transition.archive,
        overrodeFidelityGate: decision.overrodeGate,
        gatePassed: decision.gatePassed,
        reason: command.reason ?? null,
      },
    });

    return toView(surface, target.version);
  }

  /** The client read path: the published tree for a surface, or 404. */
  async live(projectId: string, key: string): Promise<LiveSurfaceView> {
    const surface = await this.require(projectId, key);
    if (!surface.publishedVersionId) {
      throw AppError.notFound(`no published version for surface "${key}"`);
    }

    const version = await this.deps.repo.findVersionById(surface.publishedVersionId);
    if (!version?.dslArtifactId) {
      throw AppError.internal(`published version for "${key}" has no tree`);
    }

    const [digest, tree] = await Promise.all([
      this.deps.artifacts.digestOf(projectId, version.dslArtifactId),
      this.deps.artifacts.readJson(projectId, version.dslArtifactId),
    ]);

    return {
      key,
      version: version.version,
      digest,
      publishedAt: version.publishedAt?.toISOString() ?? null,
      tree,
    };
  }

  async require(projectId: string, key: string): Promise<Surface> {
    const found = await this.deps.repo.findByKey(projectId, key);
    if (!found) throw AppError.notFound("surface", key);
    return found;
  }

  async requireVersion(surfaceId: string, version: number): Promise<SurfaceVersion> {
    const found = await this.deps.repo.findVersion(surfaceId, version);
    if (!found) throw AppError.notFound("surface version", String(version));
    return found;
  }

  private async withPublishedNumber(surface: Surface): Promise<SurfaceView> {
    if (!surface.publishedVersionId) return toView(surface, null);
    const version = await this.deps.repo.findVersionById(surface.publishedVersionId);
    return toView(surface, version?.version ?? null);
  }
}

function toView(surface: Surface, publishedVersion: number | null): SurfaceView {
  return {
    id: surface.id,
    key: surface.key,
    name: surface.name,
    publishedVersion,
    createdAt: surface.createdAt.toISOString(),
  };
}

function toVersionView(version: SurfaceVersion): SurfaceVersionView {
  return {
    id: version.id,
    version: version.version,
    status: version.status,
    dslArtifactId: version.dslArtifactId,
    irArtifactId: version.irArtifactId,
    sourceRunId: version.sourceRunId,
    notes: version.notes,
    createdAt: version.createdAt.toISOString(),
    createdBy: version.createdBy,
    publishedAt: version.publishedAt?.toISOString() ?? null,
  };
}
