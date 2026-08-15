/**
 * Driven ports for artifacts.
 *
 * `BlobStore` was already a port before this refactor and needed no changes,
 * which is the argument for the shape in miniature: the fs/S3 decision has
 * never once leaked into a service.
 */
import type { Artifact, ArtifactKind } from "./artifact.js";

export interface NewArtifact {
  projectId: string;
  kind: ArtifactKind;
  digest: string;
  mediaType: string;
  sizeBytes: number;
  storageKey: string;
  meta: Record<string, unknown>;
  createdBy: string | null;
}

export interface ArtifactRepository {
  /**
   * Insert, or return the row already holding these bytes. Returning `created`
   * rather than throwing on conflict is what makes a retried upload free
   * instead of an error the caller has to special-case.
   */
  upsert(input: NewArtifact): Promise<{ artifact: Artifact; created: boolean }>;
  findById(projectId: string, id: string): Promise<Artifact | null>;
  findByDigest(projectId: string, digest: string): Promise<Artifact | null>;
  list(
    projectId: string,
    opts: { kind?: ArtifactKind; limit: number; before?: Date },
  ): Promise<Artifact[]>;
}

export interface BlobStore {
  /** Writes only if absent. The same digest twice is a no-op, not an overwrite. */
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  has(key: string): Promise<boolean>;
}
