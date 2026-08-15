import type { Project } from "./project.js";

export interface NewProject {
  slug: string;
  name: string;
  themeUuid: string | null;
}

export interface ProjectRepository {
  create(input: NewProject): Promise<Project>;
  findBySlug(slug: string): Promise<Project | null>;
  findById(id: string): Promise<Project | null>;
  listActive(): Promise<Project[]>;
}
