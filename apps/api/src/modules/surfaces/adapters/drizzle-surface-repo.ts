/**
 * Postgres adapter for `SurfaceRepository`.
 *
 * Two things earn their keep here and nowhere else:
 *
 *   - `createVersion` allocates the number inside a transaction with the
 *     surface row locked (`select ... for update`). The domain's
 *     `nextVersionNumber` says what "next" means; only the database can make
 *     two concurrent callers agree on it. `tests/integration` proves it.
 *   - `applyPublish` writes all three changes or none. The port is one method
 *     precisely so this can be one transaction.
 *
 * Everything else is mapping rows to domain objects, which is the boring half
 * of an adapter and should stay boring.
 */
import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../../../platform/db/client.js";
import {
  surfaceVersions,
  surfaces,
  type SurfaceRow,
  type SurfaceVersionRow,
} from "../../../platform/db/schema.js";
import { AppError } from "../../../kernel/errors.js";
import type { NewSurface, NewVersion, SurfaceRepository } from "../domain/ports.js";
import type { PublishTransition, Surface, SurfaceVersion } from "../domain/surface.js";

export class DrizzleSurfaceRepository implements SurfaceRepository {
  constructor(private readonly db: Db) {}

  async create(input: NewSurface): Promise<Surface> {
    const rows = await this.db.insert(surfaces).values(input).returning();
    return toSurface(expectOne(rows, "surface"));
  }

  async findByKey(projectId: string, key: string): Promise<Surface | null> {
    const rows = await this.db
      .select()
      .from(surfaces)
      .where(and(eq(surfaces.projectId, projectId), eq(surfaces.key, key)))
      .limit(1);
    return rows[0] ? toSurface(rows[0]) : null;
  }

  async listByProject(projectId: string): Promise<Surface[]> {
    const rows = await this.db
      .select()
      .from(surfaces)
      .where(eq(surfaces.projectId, projectId))
      .orderBy(surfaces.key);
    return rows.map(toSurface);
  }

  async createVersion(input: NewVersion): Promise<SurfaceVersion> {
    const row = await this.db.transaction(async (tx) => {
      // The lock is the point. Without it two compiles finishing together both
      // read max=3 and both try to insert v4; one gets a unique violation and a
      // perfectly good run is lost.
      await tx.execute(sql`select id from ${surfaces} where id = ${input.surfaceId} for update`);

      const [next] = await tx
        .select({ value: sql<number>`coalesce(max(${surfaceVersions.version}), 0) + 1` })
        .from(surfaceVersions)
        .where(eq(surfaceVersions.surfaceId, input.surfaceId));

      const inserted = await tx
        .insert(surfaceVersions)
        .values({ ...input, version: next?.value ?? 1 })
        .returning();

      return expectOne(inserted, "surface version");
    });

    return toVersion(row);
  }

  async findVersion(surfaceId: string, version: number): Promise<SurfaceVersion | null> {
    const rows = await this.db
      .select()
      .from(surfaceVersions)
      .where(and(eq(surfaceVersions.surfaceId, surfaceId), eq(surfaceVersions.version, version)))
      .limit(1);
    return rows[0] ? toVersion(rows[0]) : null;
  }

  async findVersionById(id: string): Promise<SurfaceVersion | null> {
    const rows = await this.db
      .select()
      .from(surfaceVersions)
      .where(eq(surfaceVersions.id, id))
      .limit(1);
    return rows[0] ? toVersion(rows[0]) : null;
  }

  async listVersions(surfaceId: string): Promise<SurfaceVersion[]> {
    const rows = await this.db
      .select()
      .from(surfaceVersions)
      .where(eq(surfaceVersions.surfaceId, surfaceId))
      .orderBy(surfaceVersions.version);
    return rows.map(toVersion);
  }

  async applyPublish(
    surfaceId: string,
    transition: PublishTransition,
    at: Date,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (transition.archive) {
        await tx
          .update(surfaceVersions)
          .set({ status: "archived" })
          .where(eq(surfaceVersions.id, transition.archive));
      }
      await tx
        .update(surfaceVersions)
        .set({ status: "published", publishedAt: at })
        .where(eq(surfaceVersions.id, transition.publish));
      await tx
        .update(surfaces)
        .set({ publishedVersionId: transition.pointerTo })
        .where(eq(surfaces.id, surfaceId));
    });
  }

  async attachTree(versionId: string, dslArtifactId: string): Promise<void> {
    await this.db
      .update(surfaceVersions)
      .set({ status: "candidate", dslArtifactId })
      .where(eq(surfaceVersions.id, versionId));
  }
}

function toSurface(row: SurfaceRow): Surface {
  return {
    id: row.id,
    projectId: row.projectId,
    key: row.key,
    name: row.name,
    publishedVersionId: row.publishedVersionId,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
  };
}

function toVersion(row: SurfaceVersionRow): SurfaceVersion {
  return {
    id: row.id,
    surfaceId: row.surfaceId,
    version: row.version,
    status: row.status,
    dslArtifactId: row.dslArtifactId,
    irArtifactId: row.irArtifactId,
    sourceRunId: row.sourceRunId,
    notes: row.notes,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    publishedAt: row.publishedAt,
  };
}

export function expectOne<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (!row) throw AppError.internal(`${what} write returned no row`);
  return row;
}
