/**
 * HTTP driving adapter for projects. Parses, calls one use case, serialises.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppContext } from "../../../context.js";
import { CreateProjectCommand } from "../domain/project.js";

const Params = z.object({ project: z.string() });

export async function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post("/projects", async (request, reply) => {
    const command = CreateProjectCommand.parse(request.body);
    return reply.code(201).send(await ctx.projects.create(command, request.actor));
  });

  app.get("/projects", async () => ({ projects: await ctx.projects.list() }));

  app.get("/projects/:project", async (request) => {
    const { project } = Params.parse(request.params);
    return ctx.projects.get(project);
  });

  app.get("/projects/:project/audit", async (request) => {
    const { project } = Params.parse(request.params);
    const query = z
      .object({
        subjectType: z.string().optional(),
        subjectId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(request.query);

    const projectId = await ctx.projects.requireId(project);
    return { entries: await ctx.audit.list({ projectId, ...query }) };
  });
}
