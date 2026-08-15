/**
 * The driven ports for surfaces.
 *
 * Written from the domain's point of view, not the database's: the service asks
 * for "the version numbered 3 of this surface", never for a row. Two rules kept
 * these honest —
 *
 *   - no method leaks SQL, a transaction handle, or a Drizzle type;
 *   - anything that must happen atomically is ONE method, so the adapter can
 *     wrap it in a transaction and the fake can just do it.
 *
 * `applyPublish` is the clearest case. It could have been three setters, and
 * then every adapter would have to remember to wrap them — and the fake would
 * silently allow a half-applied publish that Postgres never would.
 */
import type {
  GateVerdict,
  PublishTransition,
  Surface,
  SurfaceVersion,
  VersionStatus,
} from "./surface.js";

export interface NewSurface {
  projectId: string;
  key: string;
  name: string;
}

export interface NewVersion {
  surfaceId: string;
  status: Extract<VersionStatus, "draft" | "candidate">;
  dslArtifactId: string | null;
  irArtifactId: string | null;
  sourceRunId: string | null;
  notes: string | null;
  createdBy: string | null;
}

export interface SurfaceRepository {
  create(input: NewSurface): Promise<Surface>;
  findByKey(projectId: string, key: string): Promise<Surface | null>;
  listByProject(projectId: string): Promise<Surface[]>;

  /**
   * Allocates the next version number and inserts, atomically. The number is
   * the repository's to assign precisely because "atomically" is a storage
   * guarantee — see `nextVersionNumber` for the shared definition of "next".
   */
  createVersion(input: NewVersion): Promise<SurfaceVersion>;
  findVersion(surfaceId: string, version: number): Promise<SurfaceVersion | null>;
  findVersionById(id: string): Promise<SurfaceVersion | null>;
  listVersions(surfaceId: string): Promise<SurfaceVersion[]>;

  /** Applies a whole publish transition, or none of it. */
  applyPublish(surfaceId: string, transition: PublishTransition, at: Date): Promise<void>;

  /** Used by the pipeline when a run attaches a compiled tree to a draft. */
  attachTree(versionId: string, dslArtifactId: string): Promise<void>;
}

/**
 * What surfaces needs from the artifact store — declared here, by the consumer,
 * rather than imported from the artifacts module.
 *
 * That direction is the whole trick: surfaces depends on an interface it owns,
 * artifacts happens to satisfy it, and neither module imports the other's
 * internals. Swapping in a fake needs three methods, not the artifact service.
 */
export interface ArtifactLookup {
  /** Accepts a uuid or a digest; returns the canonical id. Throws if absent. */
  resolveId(projectId: string, ref: string): Promise<string>;
  digestOf(projectId: string, artifactId: string): Promise<string>;
  readJson(projectId: string, artifactId: string): Promise<unknown>;
}

/** What surfaces needs from the fidelity gate to make a publish decision. */
export interface GateLookup {
  latestForVersion(surfaceVersionId: string): Promise<GateVerdict | null>;
}
