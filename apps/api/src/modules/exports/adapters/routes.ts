/**
 * HTTP driving adapter for exports.
 *
 * `POST /v1/exports` carries no project in the path — the tenant is resolved
 * from the Figma file key, because the plugin has no idea projects exist.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppContext } from "../../../context.js";
import { IngestExportCommand, ListExportsQuery } from "../domain/export.js";

const Params = z.object({ project: z.string() });
const ExportParams = Params.extend({ export: z.string().uuid() });

export async function registerExportRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post("/exports", async (request, reply) => {
    const command = IngestExportCommand.parse(request.body);
    const view = await ctx.exports.ingest(command, request.actor);
    // 200 when this exact send was already recorded, so a retry is visibly a
    // no-op rather than looking like a second export.
    return reply.code(view.deduplicated ? 200 : 201).send(view);
  });

  app.get("/projects/:project/exports", async (request) => {
    const { project } = Params.parse(request.params);
    const query = ListExportsQuery.parse(request.query);
    const projectId = await ctx.projects.requireId(project);
    return { exports: await ctx.exports.list(projectId, query) };
  });

  app.get("/projects/:project/exports/:export", async (request) => {
    const { project, export: id } = ExportParams.parse(request.params);
    const projectId = await ctx.projects.requireId(project);
    return ctx.exports.get(projectId, id);
  });

  /** Promotion is a human act, separate from receiving. */
  app.post("/projects/:project/exports/:export/status", async (request) => {
    const { project, export: id } = ExportParams.parse(request.params);
    const body = z
      .object({
        status: z.enum(["received", "promoted", "dismissed"]),
        runId: z.string().uuid().nullable().default(null),
      })
      .parse(request.body);

    const projectId = await ctx.projects.requireId(project);
    return ctx.exports.setStatus(projectId, id, body.status, request.actor, body.runId);
  });

  /** Claim a Figma file for a project, so its exports can find a tenant. */
  app.post("/projects/:project/figma-files", async (request, reply) => {
    const { project } = Params.parse(request.params);
    const body = z
      .object({ fileKey: z.string().min(1), fileName: z.string().nullable().default(null) })
      .parse(request.body);

    const projectId = await ctx.projects.requireId(project);
    await ctx.figmaFiles.claim(projectId, body.fileKey, body.fileName);
    return reply.code(201).send({ projectId, fileKey: body.fileKey });
  });
}
