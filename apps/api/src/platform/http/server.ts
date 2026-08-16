/**
 * The primary driving adapter: Fastify.
 *
 * Deliberately thin. It authenticates, parses, calls one use case, and
 * serialises. `AppError` carries a status code so the domain can say "that is a
 * conflict" without knowing what a response is — turning that into a reply is
 * this file's entire job, and it is why the worker reuses every service with no
 * HTTP in sight.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";

import type { AppContext } from "../../context.js";
import { isAppError } from "../../kernel/errors.js";
import { registerArtifactRoutes } from "../../modules/artifacts/adapters/routes.js";
import { registerExportRoutes } from "../../modules/exports/adapters/routes.js";
import { registerProjectRoutes } from "../../modules/projects/adapters/routes.js";
import { registerRunRoutes } from "../../modules/runs/adapters/routes.js";
import { registerSurfaceRoutes } from "../../modules/surfaces/adapters/routes.js";
import { registerSyncRoutes } from "../../modules/sync/adapters/routes.js";
import { PASSTHROUGH_HEADERS } from "../../modules/sync/domain/shape.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth hook. "anonymous" when auth is disabled in development. */
    actor: string;
  }
}

export function buildServer(ctx: AppContext): FastifyInstance {
  const app = Fastify({
    logger: { level: ctx.config.LOG_LEVEL },
    // Artifact uploads carry base64 PNGs; the default 1MB is too tight.
    bodyLimit: 32 * 1024 * 1024,
  });

  app.decorateRequest("actor", "");

  /**
   * CORS, against an explicit allowlist.
   *
   * `Access-Control-Expose-Headers` is the load-bearing line: without it the
   * browser hides the `electric-*` headers from JS, the client loses its
   * cursor, and every reconnect silently degrades into a full refetch instead
   * of resuming. It fails as a performance mystery rather than an error.
   */
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && ctx.config.corsOrigins.has(origin)) {
      void reply
        .header("access-control-allow-origin", origin)
        .header("vary", "origin")
        .header("access-control-allow-headers", "authorization,x-api-key,content-type")
        .header("access-control-allow-methods", "GET,POST,OPTIONS")
        .header("access-control-expose-headers", PASSTHROUGH_HEADERS.join(","));
    }

    if (request.method === "OPTIONS") {
      await reply.code(204).send();
      return;
    }

    if (isPublic(request)) {
      request.actor = "anonymous";
      return;
    }

    if (ctx.config.apiKeys.size === 0) {
      // Only reachable outside production — loadConfig refuses to boot a
      // production process with no keys.
      request.actor = "anonymous";
      return;
    }

    const key = bearer(request);
    if (!key || !ctx.config.apiKeys.has(key)) {
      await reply.code(401).send({ error: { code: "unauthorized", message: "invalid api key" } });
      return;
    }
    // Keys are opaque; the prefix distinguishes callers in the audit log
    // without writing the secret into the database.
    request.actor = `key:${key.slice(0, 8)}`;
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: { code: "bad_request", message: "request failed validation", details: err.issues },
      });
    }

    if (isAppError(err)) {
      if (err.status >= 500) request.log.error({ err }, "internal error");
      return reply.code(err.status).send({
        error: { code: err.code, message: err.message, details: err.details ?? null },
      });
    }

    // Fastify's own errors (bad JSON, payload too large) carry a statusCode.
    const status = statusCodeOf(err) ?? 500;
    if (status >= 500) request.log.error({ err }, "unhandled error");

    return reply.code(status).send({
      error: {
        code: status >= 500 ? "internal" : "bad_request",
        // Never leak an internal message; a 4xx from Fastify is safe to echo.
        message: status >= 500 ? "internal server error" : messageOf(err),
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: { code: "not_found", message: `no route for ${request.method} ${request.url}` },
    });
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/ready", async () => {
    await ctx.health.ping();
    return { ok: true };
  });

  app.register(
    async (api) => {
      await registerProjectRoutes(api, ctx);
      await registerArtifactRoutes(api, ctx);
      await registerSurfaceRoutes(api, ctx);
      await registerRunRoutes(api, ctx);
      await registerSyncRoutes(api, ctx);
      await registerExportRoutes(api, ctx);
    },
    { prefix: "/v1" },
  );

  return app;
}

const PUBLIC = new Set(["/health", "/ready"]);

function isPublic(request: FastifyRequest): boolean {
  return PUBLIC.has(request.url.split("?")[0] ?? "");
}

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  const apiKey = request.headers["x-api-key"];
  return typeof apiKey === "string" ? apiKey.trim() : null;
}

function statusCodeOf(err: unknown): number | null {
  const code = (err as { statusCode?: unknown }).statusCode;
  return typeof code === "number" ? code : null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
