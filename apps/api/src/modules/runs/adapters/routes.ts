/**
 * HTTP driving adapter for runs.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppContext } from "../../../context.js";
import { ListRunsQuery, StartRunCommand } from "../domain/run.js";

const Params = z.object({ project: z.string() });
const RunParams = Params.extend({ run: z.string().uuid() });

export async function registerRunRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post("/projects/:project/runs", async (request, reply) => {
    const { project } = Params.parse(request.params);
    const command = StartRunCommand.parse(request.body);
    const projectId = await ctx.projects.requireId(project);

    // 202: accepted, not done. The caller polls GET /runs/:id.
    return reply.code(202).send(await ctx.runs.start(projectId, command, request.actor));
  });

  app.get("/projects/:project/runs", async (request) => {
    const { project } = Params.parse(request.params);
    const query = ListRunsQuery.parse(request.query);
    const projectId = await ctx.projects.requireId(project);
    return { runs: await ctx.runs.list(projectId, query) };
  });

  app.get("/projects/:project/runs/:run", async (request) => {
    const { project, run } = RunParams.parse(request.params);
    const projectId = await ctx.projects.requireId(project);
    return ctx.runs.get(projectId, run);
  });

  app.post("/projects/:project/runs/:run/cancel", async (request) => {
    const { project, run } = RunParams.parse(request.params);
    const projectId = await ctx.projects.requireId(project);
    return ctx.runs.cancel(projectId, run, request.actor);
  });

  app.get("/projects/:project/runs/:run/fidelity", async (request) => {
    const { project, run } = RunParams.parse(request.params);
    const projectId = await ctx.projects.requireId(project);
    // Resolves and 404s if the run belongs to another project.
    await ctx.runs.get(projectId, run);
    return { reports: await ctx.fidelity.forRun(run) };
  });
}
