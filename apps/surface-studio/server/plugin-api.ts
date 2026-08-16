/**
 * Vite middleware. Surface Studio stores nothing.
 *
 *   GET  /v1/health
 *   POST /v1/exports   -> forwarded to the control plane
 *   GET  /v1/sync      -> proxied to the control plane's Electric proxy
 *
 * Two reasons this process still exists at all:
 *
 *   1. The Figma plugin's manifest allowlists exactly one origin — this one.
 *      It cannot post to the API directly without every designer reloading the
 *      plugin, so this forwards on its behalf.
 *   2. The API key stays server-side. The board's live sync goes back out
 *      through here rather than the browser calling :4000, because a key in a
 *      browser bundle is a published key.
 *
 * CORS is open for the plugin: the Figma sandbox fetch and a null-origin
 * iframe both have to land here, and locking origin would fail one of them.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, ViteDevServer } from "vite";
import { authHeaders, loadStudioConfig, type StudioConfig } from "./config.js";
import { studioExportSchema } from "./schema.js";

export function surfaceStudioApi() {
  const config = loadStudioConfig();
  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void) =>
    handle(config, req, res, next);

  return {
    name: "surface-studio-api",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(handler);
    },
  };
}

function handle(
  config: StudioConfig,
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  const url = req.url ?? "";
  if (!url.startsWith("/v1/")) {
    next();
    return;
  }

  cors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  void route(config, url, req, res).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    json(res, 502, { message: `control plane unreachable: ${message}` });
  });
}

async function route(
  config: StudioConfig,
  url: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const path = url.split("?")[0] ?? "";

  if (path === "/v1/health" && req.method === "GET") {
    const upstream = await fetch(`${config.apiUrl}/health`).catch(() => null);
    json(res, 200, {
      ok: true,
      project: config.projectRef,
      controlPlane: upstream?.ok ? "reachable" : "unreachable",
    });
    return;
  }

  if (path === "/v1/exports" && req.method === "POST") {
    await forwardExport(config, req, res);
    return;
  }

  // Thumbnails are blobs now, not inline base64 — fetched once and cached by
  // the browser rather than re-sent with every board update.
  if (path.startsWith("/v1/blobs/") && req.method === "GET") {
    await proxyBlob(config, path.slice("/v1/blobs/".length), res);
    return;
  }

  if (path === "/v1/sync" && req.method === "GET") {
    await proxySync(config, url, req, res);
    return;
  }

  json(res, 404, { message: "not found" });
}

/**
 * Validate locally, then hand the whole payload to the control plane.
 *
 * Parsing here is not duplication of the API's own validation — it is so a
 * malformed export fails against the plugin with a useful message instead of
 * travelling to another service to be rejected there.
 */
async function forwardExport(
  config: StudioConfig,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readBody(req);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    json(res, 400, { message: "body is not JSON" });
    return;
  }

  const body = studioExportSchema.safeParse(parsed);
  if (!body.success) {
    json(res, 400, { message: body.error.issues[0]?.message ?? "invalid export" });
    return;
  }

  const upstream = await fetch(`${config.apiUrl}/v1/exports`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(config) },
    body: raw,
  });

  // Relay the control plane's answer verbatim. An unmapped Figma file comes
  // back as a 422 explaining how to claim it, and the designer needs to read
  // that rather than a generic failure from here.
  const text = await upstream.text();
  res.statusCode = upstream.status;
  res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
  res.end(text);
}

/**
 * Proxy the board's live sync, adding the service credential.
 *
 * Long-poll: no timeout of our own, and the upstream request is aborted when
 * the browser goes away, so an abandoned tab does not hold a connection open
 * for the full live window.
 */
async function proxySync(
  config: StudioConfig,
  url: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const search = url.includes("?") ? url.slice(url.indexOf("?")) : "";
  const target = `${config.apiUrl}/v1/projects/${encodeURIComponent(config.projectRef)}/sync${search}`;

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  const upstream = await fetch(target, {
    headers: authHeaders(config),
    signal: controller.signal,
  });

  // Electric's cursor headers must survive, or the client silently loses its
  // place and refetches everything on each reconnect.
  for (const [name, value] of upstream.headers) {
    if (name.startsWith("electric-") || name === "content-type") res.setHeader(name, value);
  }
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = upstream.status;
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

async function proxyBlob(
  config: StudioConfig,
  ref: string,
  res: ServerResponse,
): Promise<void> {
  const target =
    `${config.apiUrl}/v1/projects/${encodeURIComponent(config.projectRef)}` +
    `/artifacts/${encodeURIComponent(ref)}/content`;

  const upstream = await fetch(target, { headers: authHeaders(config) });
  res.statusCode = upstream.status;
  res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "image/png");
  // Artifacts are immutable by construction, so this can never go stale.
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "electric-handle,electric-offset,electric-schema,electric-cursor,electric-up-to-date,electric-has-data",
  );
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
