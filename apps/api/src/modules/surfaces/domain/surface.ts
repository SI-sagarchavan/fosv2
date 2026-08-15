/**
 * Surfaces: the types the domain owns, and the rules that govern them.
 *
 * Everything below is a pure function of values handed in. No repository, no
 * clock, no database. That is what makes the publish rules — the most important
 * and most breakable logic in this system — testable in milliseconds.
 *
 * These types are deliberately NOT the persistence rows. The database is free
 * to store `published_version_id` as a nullable uuid column; the domain thinks
 * in terms of "a surface has at most one published version". When those two
 * disagree, the adapter is what changes.
 */
import { z } from "zod";

export type VersionStatus = "draft" | "candidate" | "published" | "archived";

export interface Surface {
  id: string;
  projectId: string;
  key: string;
  name: string;
  publishedVersionId: string | null;
  createdAt: Date;
  archivedAt: Date | null;
}

export interface SurfaceVersion {
  id: string;
  surfaceId: string;
  version: number;
  status: VersionStatus;
  /** The compiled SDUI tree served to clients. Null until a run attaches one. */
  dslArtifactId: string | null;
  /** The Figma IR it came from — the provenance half of the pair. */
  irArtifactId: string | null;
  sourceRunId: string | null;
  notes: string | null;
  createdAt: Date;
  createdBy: string | null;
  publishedAt: Date | null;
}

/** What the gate said about a version. Supplied by the fidelity module. */
export interface GateVerdict {
  passed: boolean;
  score: number;
}

// ---------------------------------------------------------------------------
// commands — what a caller may send
// ---------------------------------------------------------------------------

const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const CreateSurfaceCommand = z.object({
  key: z.string().min(2).max(80).regex(KEY, "key must be lowercase kebab-case"),
  name: z.string().min(1).max(200),
});
export type CreateSurfaceCommand = z.infer<typeof CreateSurfaceCommand>;

export const CreateVersionCommand = z.object({
  /** Artifact id or digest of the DSL tree. Omit when a run will supply it. */
  dslArtifact: z.string().min(1).optional(),
  irArtifact: z.string().min(1).optional(),
  notes: z.string().max(2000).optional(),
});
export type CreateVersionCommand = z.infer<typeof CreateVersionCommand>;

export const PublishCommand = z.object({
  version: z.number().int().positive(),
  /** Publishing past a failed gate is possible, but never accidental. */
  overrideFidelityGate: z.boolean().default(false),
  reason: z.string().max(500).optional(),
});
export type PublishCommand = z.infer<typeof PublishCommand>;

// ---------------------------------------------------------------------------
// views — what a caller gets back. Separate types on purpose.
// ---------------------------------------------------------------------------

export interface SurfaceView {
  id: string;
  key: string;
  name: string;
  publishedVersion: number | null;
  createdAt: string;
}

export interface SurfaceVersionView {
  id: string;
  version: number;
  status: VersionStatus;
  dslArtifactId: string | null;
  irArtifactId: string | null;
  sourceRunId: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
  publishedAt: string | null;
}

/** What a client rendering the surface actually receives. */
export interface LiveSurfaceView {
  key: string;
  version: number;
  digest: string;
  publishedAt: string | null;
  tree: unknown;
}

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

export type PublishRefusal =
  | { reason: "no-tree"; message: string }
  | { reason: "no-report"; message: string }
  | { reason: "gate-failed"; message: string; score: number };

export type PublishDecision =
  | { allowed: true; overrodeGate: boolean; gatePassed: boolean | null }
  | { allowed: false; refusal: PublishRefusal };

/**
 * The rule that decides whether a version may go live.
 *
 * Order matters and is not arbitrary. A version with no compiled tree is
 * unpublishable even *with* an override — there is nothing to serve, so the
 * override would produce a surface that 500s rather than one that is merely
 * off-spec. Gate failures are a judgement call and can be overridden; a missing
 * tree is a broken state and cannot.
 */
export function canPublish(
  version: Pick<SurfaceVersion, "version" | "dslArtifactId">,
  gate: GateVerdict | null,
  opts: { overrideFidelityGate: boolean },
): PublishDecision {
  if (!version.dslArtifactId) {
    return {
      allowed: false,
      refusal: {
        reason: "no-tree",
        message: `version ${version.version} has no compiled tree and cannot be published`,
      },
    };
  }

  if (opts.overrideFidelityGate) {
    return { allowed: true, overrodeGate: true, gatePassed: gate?.passed ?? null };
  }

  if (!gate) {
    return {
      allowed: false,
      refusal: {
        reason: "no-report",
        message:
          `version ${version.version} has no fidelity report; ` +
          `run the gate or pass overrideFidelityGate`,
      },
    };
  }

  if (!gate.passed) {
    return {
      allowed: false,
      refusal: {
        reason: "gate-failed",
        message: `version ${version.version} failed the fidelity gate`,
        score: gate.score,
      },
    };
  }

  return { allowed: true, overrodeGate: false, gatePassed: true };
}

/**
 * Version numbers are dense and monotonic per surface.
 *
 * Note the honest limit of this function: it is correct given a complete list,
 * but it cannot make two concurrent callers agree. The Drizzle adapter does the
 * allocation in SQL under a row lock for that reason, and an integration test
 * covers the race. This is the shared definition, and what the in-memory fake
 * uses.
 */
export function nextVersionNumber(existing: readonly number[]): number {
  return existing.reduce((max, n) => (n > max ? n : max), 0) + 1;
}

/**
 * The state changes a publish implies. Returned as data so the adapter can
 * apply them in one transaction and the test can assert on them directly.
 */
export interface PublishTransition {
  publish: string;
  archive: string | null;
  pointerTo: string;
}

export function publishTransition(surface: Surface, target: SurfaceVersion): PublishTransition {
  const previous = surface.publishedVersionId;
  return {
    publish: target.id,
    // Re-publishing the version that is already live must not archive it.
    archive: previous && previous !== target.id ? previous : null,
    pointerTo: target.id,
  };
}

/** Exactly one version per surface may be `published`. Used as a test oracle. */
export function publishedCount(versions: readonly SurfaceVersion[]): number {
  return versions.filter((v) => v.status === "published").length;
}
