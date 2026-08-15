/**
 * HTTP driving adapter for artifacts.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppContext } from "../../../context.js";
import { ListArtifactsQuery, UploadArtifactCommand } from "../domain/artifact.js";

const Params = z.object({ project: z.string() });
const RefParams = Params.extend({ ref: z.string() });

export async function registerArtifactRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post("/projects/:project/artifacts", async (request, reply) => {
    const { project } = Params.parse(request.params);
    const command = UploadArtifactCommand.parse(request.body);
    const projectId = await ctx.projects.requireId(project);

    const artifact = await ctx.artifacts.upload(projectId, command, request.actor);
    // 200 rather than 201 when the bytes were already here — the caller can
    // tell the difference, and it makes retries visibly free.
    return reply.code(artifact.deduplicated ? 200 : 201).send(artifact);
  });

  app.get("/projects/:project/artifacts", async (request) => {
    const { project } = Params.parse(request.params);
    const query = ListArtifactsQuery.parse(request.query);
    const projectId = await ctx.projects.requireId(project);
    return { artifacts: await ctx.artifacts.list(projectId, query) };
  });

  app.get("/projects/:project/artifacts/:ref", async (request) => {
    const { project, ref } = RefParams.parse(request.params);
    const projectId = await ctx.projects.requireId(project);
    return ctx.artifacts.get(projectId, ref);
  });

  /** The bytes themselves. Immutable by construction, so cache hard. */
  app.get("/projects/:project/artifacts/:ref/content", async (request, reply) => {
    const { project, ref } = RefParams.parse(request.params);
    const projectId = await ctx.projects.requireId(project);
    const { artifact, bytes } = await ctx.artifacts.download(projectId, ref);

    return reply
      .header("content-type", artifact.mediaType)
      .header("etag", `"${artifact.digest}"`)
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(Buffer.from(bytes));
  });
}
