/**
 * Postgres adapter for `ArtifactRepository`.
 *
 * The unique index on (project_id, digest) is the real guard against duplicate
 * artifacts; `onConflictDoNothing` turns a race between two uploaders into a
 * second read rather than an error either of them has to handle.
 */
import { and, desc, eq, lt, type SQL } from "drizzle-orm";

import type { Db } from "../../../platform/db/client.js";
import { artifacts, type ArtifactRow } from "../../../platform/db/schema.js";
import { AppError } from "../../../kernel/errors.js";
import type { Artifact, ArtifactKind } from "../domain/artifact.js";
import type { ArtifactRepository, NewArtifact } from "../domain/ports.js";

export class DrizzleArtifactRepository implements ArtifactRepository {
  constructor(private readonly db: Db) {}

  async upsert(input: NewArtifact): Promise<{ artifact: Artifact; created: boolean }> {
    const inserted = await this.db
      .insert(artifacts)
      .values(input)
      .onConflictDoNothing({ target: [artifacts.projectId, artifacts.digest] })
      .returning();

    const row = inserted[0];
    if (row) return { artifact: toArtifact(row), created: true };

    const existing = await this.findByDigest(input.projectId, input.digest);
    if (!existing) throw AppError.internal(`artifact ${input.digest} vanished mid-upsert`);
    return { artifact: existing, created: false };
  }

  async findById(projectId: string, id: string): Promise<Artifact | null> {
    const rows = await this.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.projectId, projectId), eq(artifacts.id, id)))
      .limit(1);
    return rows[0] ? toArtifact(rows[0]) : null;
  }

  async findByDigest(projectId: string, digest: string): Promise<Artifact | null> {
    const rows = await this.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.projectId, projectId), eq(artifacts.digest, digest)))
      .limit(1);
    return rows[0] ? toArtifact(rows[0]) : null;
  }

  async list(
    projectId: string,
    opts: { kind?: ArtifactKind; limit: number; before?: Date },
  ): Promise<Artifact[]> {
    const filters: SQL[] = [eq(artifacts.projectId, projectId)];
    if (opts.kind) filters.push(eq(artifacts.kind, opts.kind));
    if (opts.before) filters.push(lt(artifacts.createdAt, opts.before));

    const rows = await this.db
      .select()
      .from(artifacts)
      .where(and(...filters))
      .orderBy(desc(artifacts.createdAt))
      .limit(opts.limit);

    return rows.map(toArtifact);
  }
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    digest: row.digest,
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
    storageKey: row.storageKey,
    meta: row.meta as Record<string, unknown>,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}
