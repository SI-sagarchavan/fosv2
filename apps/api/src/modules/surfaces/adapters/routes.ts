/**
 * HTTP driving adapter for surfaces.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppContext } from "../../../context.js";
import { CreateSurfaceCommand, CreateVersionCommand, PublishCommand } from "../domain/surface.js";

const Params = z.object({ project: z.string() });
const KeyParams = Params.extend({ key: z.string() });

export async function registerSurfaceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post("/projects/:project/surfaces", async (request, reply) => {
    const { project } = Params.parse(request.params);
    const command = CreateSurfaceCommand.parse(request.body);
    const projectId = await ctx.projects.requireId(project);
    return reply.code(201).send(await ctx.surfaces.create(projectId, command, request.actor));
  });

  app.get("/projects/:project/surfaces", async (request) => {
    const { project } = Params.parse(request.params);
    const projectId = await ctx.projects.requireId(project);
    return { surfaces: await ctx.surfaces.list(projectId) };
  });

  app.get("/projects/:project/surfaces/:key", async (request) => {
    const { project, key } = KeyParams.parse(request.params);
    const projectId = await ctx.projects.requireId(project);
    return ctx.surfaces.get(projectId, key);
  });

  app.post("/projects/:project/surfaces/:key/versions", async (request, reply) => {
    const { project, key } = KeyParams.parse(request.params);
    const command = CreateVersionCommand.parse(request.body ?? {});
    const projectId = await ctx.projects.requireId(project);
    return reply
      .code(201)
      .send(await ctx.surfaces.createVersion(projectId, key, command, request.actor));
  });

  app.get("/projects/:project/surfaces/:key/versions", async (request) => {
    const { project, key } = KeyParams.parse(request.params);
    const projectId = await ctx.projects.requireId(project);
    return { versions: await ctx.surfaces.listVersions(projectId, key) };
  });

  app.post("/projects/:project/surfaces/:key/publish", async (request) => {
    const { project, key } = KeyParams.parse(request.params);
    const command = PublishCommand.parse(request.body);
    const projectId = await ctx.projects.requireId(project);
    return ctx.surfaces.publish(projectId, key, command, request.actor);
  });

  /**
   * The read path clients hit. Separate route, separate shape, no relation to
   * the write commands above — this is where a read model would slot in if it
   * ever needed to outrun Postgres.
   */
  app.get("/projects/:project/surfaces/:key/live", async (request, reply) => {
    const { project, key } = KeyParams.parse(request.params);
    const projectId = await ctx.projects.requireId(project);
    const live = await ctx.surfaces.live(projectId, key);

    return reply
      .header("etag", `"${live.digest}"`)
      // Short, because publishing moves the pointer and clients should notice.
      .header("cache-control", "public, max-age=30, stale-while-revalidate=300")
      .send(live);
  });

  app.get("/projects/:project/surfaces/:key/versions/:version/fidelity", async (request) => {
    const { project, key, version } = KeyParams.extend({
      version: z.coerce.number().int().positive(),
    }).parse(request.params);

    const projectId = await ctx.projects.requireId(project);
    const surface = await ctx.surfaces.require(projectId, key);
    const target = await ctx.surfaces.requireVersion(surface.id, version);
    return { report: await ctx.fidelity.latestForVersion(target.id) };
  });
}
