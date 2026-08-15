import { z } from "zod";

export interface Project {
  id: string;
  slug: string;
  name: string;
  themeUuid: string | null;
  createdAt: Date;
  archivedAt: Date | null;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const CreateProjectCommand = z.object({
  slug: z.string().min(2).max(64).regex(SLUG, "slug must be lowercase kebab-case"),
  name: z.string().min(1).max(200),
  themeUuid: z.string().uuid().optional(),
});
export type CreateProjectCommand = z.infer<typeof CreateProjectCommand>;

export interface ProjectView {
  id: string;
  slug: string;
  name: string;
  themeUuid: string | null;
  createdAt: string;
}

export function toProjectView(project: Project): ProjectView {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    themeUuid: project.themeUuid,
    createdAt: project.createdAt.toISOString(),
  };
}
