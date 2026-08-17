/**
 * Artifacts: immutable, content-addressed blobs and the rules about them.
 *
 * The domain rule that matters: an artifact's identity is the sha256 of its
 * bytes, scoped to a project. Everything downstream — idempotent pipelines,
 * free retries, "what exactly did we ship in March" — is a consequence of that
 * one decision, which is why it lives here and not in a repository.
 */
import { z } from "zod";

export const ARTIFACT_KINDS = [
  "figma_ir",
  "token_set",
  "dsl_tree",
  /**
   * The surfaces a compiled tree needs, merged over whatever the theme already
   * authored. Separate from `token_set` because it is per-run output, not
   * tenant input: the compiler derives it from one frame.
   */
  "surface_set",
  "render_png",
  "conform_report",
  "diff_report",
  "screenshot",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface Artifact {
  id: string;
  projectId: string;
  kind: ArtifactKind;
  digest: string;
  mediaType: string;
  sizeBytes: number;
  storageKey: string;
  meta: Record<string, unknown>;
  createdAt: Date;
  createdBy: string | null;
}

export const DEFAULT_MEDIA_TYPE: Record<ArtifactKind, string> = {
  figma_ir: "application/json",
  token_set: "application/json",
  dsl_tree: "application/json",
  surface_set: "application/json",
  render_png: "image/png",
  conform_report: "application/json",
  diff_report: "application/json",
  screenshot: "image/png",
};

/**
 * `<project>/<ab>/<cd>/<digest>` — project-scoped so a tenant can be dropped
 * wholesale, fanned out two levels so no directory collects every blob.
 *
 * This is domain rather than adapter detail because every storage backend must
 * agree on it: an fs adapter and an S3 adapter pointed at the same content have
 * to derive the same key, or a migration between them silently loses blobs.
 */
export function blobKey(projectId: string, digest: string): string {
  return `${projectId}/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
}

// --- write side -------------------------------------------------------------

export const UploadArtifactCommand = z.object({
  kind: z.enum(ARTIFACT_KINDS),
  /** Exactly one of `json` or `base64`. */
  json: z.unknown().optional(),
  base64: z.string().optional(),
  mediaType: z.string().min(1).optional(),
  meta: z.record(z.unknown()).default({}),
  /** When given, the server verifies the bytes hash to this and rejects a mismatch. */
  expectedDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type UploadArtifactCommand = z.infer<typeof UploadArtifactCommand>;

export const ListArtifactsQuery = z.object({
  kind: z.enum(ARTIFACT_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime().optional(),
});
export type ListArtifactsQuery = z.infer<typeof ListArtifactsQuery>;

// --- read side --------------------------------------------------------------

export interface ArtifactView {
  id: string;
  kind: ArtifactKind;
  digest: string;
  mediaType: string;
  sizeBytes: number;
  meta: Record<string, unknown>;
  createdAt: string;
  createdBy: string | null;
  /** Whether these exact bytes already existed. Lets a client skip re-upload. */
  deduplicated?: boolean;
}

export function toArtifactView(artifact: Artifact): ArtifactView {
  return {
    id: artifact.id,
    kind: artifact.kind,
    digest: artifact.digest,
    mediaType: artifact.mediaType,
    sizeBytes: artifact.sizeBytes,
    meta: artifact.meta,
    createdAt: artifact.createdAt.toISOString(),
    createdBy: artifact.createdBy,
  };
}
