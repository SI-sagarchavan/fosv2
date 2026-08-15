import { asc, eq, isNull } from "drizzle-orm";

import { AppError } from "../../../kernel/errors.js";
import type { Db } from "../../../platform/db/client.js";
import { projects, type ProjectRow } from "../../../platform/db/schema.js";
import type { NewProject, ProjectRepository } from "../domain/ports.js";
import type { Project } from "../domain/project.js";

export class DrizzleProjectRepository implements ProjectRepository {
  constructor(private readonly db: Db) {}

  async create(input: NewProject): Promise<Project> {
    const rows = await this.db.insert(projects).values(input).returning();
    const row = rows[0];
    if (!row) throw AppError.internal("project write returned no row");
    return toProject(row);
  }

  async findBySlug(slug: string): Promise<Project | null> {
    const rows = await this.db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
    return rows[0] ? toProject(rows[0]) : null;
  }

  async findById(id: string): Promise<Project | null> {
    const rows = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    return rows[0] ? toProject(rows[0]) : null;
  }

  async listActive(): Promise<Project[]> {
    const rows = await this.db
      .select()
      .from(projects)
      .where(isNull(projects.archivedAt))
      .orderBy(asc(projects.slug));
    return rows.map(toProject);
  }
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    themeUuid: row.themeUuid,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
  };
}
