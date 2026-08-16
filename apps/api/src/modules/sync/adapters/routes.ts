/**
 * HTTP driving adapter for sync.
 *
 * The browser talks to this, never to Electric. It carries the same API key as
 * every other route, so a sync subscription is authorized exactly like a read.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppContext } from "../../../context.js";
import { SyncQuery } from "../domain/shape.js";

const Params = z.object({ project: z.string() });

export async function registerSyncRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/projects/:project/sync", async (request, reply) => {
    const { project } = Params.parse(request.params);
    const query = SyncQuery.parse(request.query);
    const projectId = await ctx.projects.requireId(project);

    // Long-poll requests are abandoned when the browser navigates away; pass
    // the signal down so the upstream fetch is dropped with it rather than
    // held open for the full live timeout.
    const controller = new AbortController();
    request.raw.on("close", () => controller.abort());

    const shape = await ctx.sync.shape(projectId, query, controller.signal);

    for (const [name, value] of Object.entries(shape.headers)) {
      void reply.header(name, value);
    }

    // Electric's own cache headers are for its CDN, not for us. A proxied
    // response is per-tenant, so it must never land in a shared cache.
    return reply
      .header("cache-control", "no-store")
      .code(shape.status)
      .send(Buffer.from(shape.body));
  });
}
