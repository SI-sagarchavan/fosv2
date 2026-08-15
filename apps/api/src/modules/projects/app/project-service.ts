/**
 * Tenants. Small on purpose — its real job is to be what every other module
 * resolves an id against, so callers may address a project by slug and
 * everything downstream deals only in uuids.
 */
import type { AuditSink } from "../../../kernel/audit.js";
import { AppError } from "../../../kernel/errors.js";
import { isUuid } from "../../../kernel/hash.js";
import type { ProjectRepository } from "../domain/ports.js";
import {
  toProjectView,
  type CreateProjectCommand,
  type Project,
  type ProjectView,
} from "../domain/project.js";

export interface ProjectServiceDeps {
  repo: ProjectRepository;
  audit: AuditSink;
}

export class ProjectService {
  constructor(private readonly deps: ProjectServiceDeps) {}

  async create(command: CreateProjectCommand, actor: string): Promise<ProjectView> {
    const clash = await this.deps.repo.findBySlug(command.slug);
    if (clash) throw AppError.conflict(`project slug "${command.slug}" is taken`);

    const project = await this.deps.repo.create({
      slug: command.slug,
      name: command.name,
      themeUuid: command.themeUuid ?? null,
    });

    await this.deps.audit.record({
      projectId: project.id,
      actor,
      action: "project.created",
      subjectType: "project",
      subjectId: project.id,
      diff: { slug: project.slug, name: project.name },
    });

    return toProjectView(project);
  }

  async list(): Promise<ProjectView[]> {
    return (await this.deps.repo.listActive()).map(toProjectView);
  }

  async get(ref: string): Promise<ProjectView> {
    return toProjectView(await this.require(ref));
  }

  /** Resolves a slug or uuid to the project, 404ing if it is neither. */
  async require(ref: string): Promise<Project> {
    const found = isUuid(ref)
      ? await this.deps.repo.findById(ref)
      : await this.deps.repo.findBySlug(ref);
    if (!found || found.archivedAt) throw AppError.notFound("project", ref);
    return found;
  }

  /** Just the id — the common case for route handlers. */
  async requireId(ref: string): Promise<string> {
    return (await this.require(ref)).id;
  }
}
