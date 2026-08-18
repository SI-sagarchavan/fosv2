/**
 * Vite middleware. Surface Studio stores nothing.
 *
 *   GET  /v1/health
 *   POST /v1/exports   -> forwarded to the control plane
 *   GET  /v1/sync      -> proxied to the control plane's Electric proxy
 *   POST /v1/compile   -> resolves a theme + surface, then starts a run
 *   POST /v1/preview   -> compiles + renders an IR document, nothing persisted
 *   GET  /v1/preview/:run -> the run's compiled tree, rendered as a page
 *   GET  /public/*        -> renderer fonts and textures, at the path its CSS wants
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
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, ViteDevServer } from "vite";
import { authHeaders, loadStudioConfig, type StudioConfig } from "./config.js";
import { compilePreview } from "./compile-preview.js";
import { renderPreview, resolvePublicAsset } from "./preview.js";
import { compileRequestSchema, previewRequestSchema, studioExportSchema } from "./schema.js";

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

  // `/public/*` is not ours by choice — it is the path the renderer's emitted
  // CSS and font faces already point at. Serving it verbatim beats rewriting
  // every asset URL and missing one.
  if (url.startsWith("/public/")) {
    servePublicAsset(url.split("?")[0] ?? "", res, next);
    return;
  }

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

  void route(config, url, req, res).catch((err: unknown) => respondToFailure(url, err, res));
}

/**
 * Blame the right system.
 *
 * Every throw used to come back as `502 control plane unreachable`, whatever
 * actually happened. A `ReferenceError` in this file — a plain bug, or a stale
 * dev-server bundle — was therefore reported as the API being down, which sends
 * whoever reads it to go and check a service that was never involved. That is
 * worse than no message: it is a confident wrong one.
 *
 * Only a failed connection is an unreachable control plane. Everything else is
 * ours, and says so.
 */
function respondToFailure(url: string, err: unknown, res: ServerResponse): void {
  const message = err instanceof Error ? err.message : String(err);

  if (isConnectionFailure(err)) {
    json(res, 502, { message: `control plane unreachable: ${message}` });
    return;
  }

  /**
   * A missing binding means the running server is not the code on disk.
   *
   * Vite bundles this middleware through the CONFIG graph, not the module
   * graph, so it only updates on a full server restart — and a restart that
   * loses a `strictPort` race leaves the old bundle serving requests. Saying so
   * turns a baffling `x is not defined` into one instruction.
   */
  const stale =
    err instanceof ReferenceError
      ? " — Surface Studio is running code older than the files on disk. Restart it (pnpm dev:studio)."
      : "";

  console.error(`[surface-studio] ${url} failed:`, err);
  json(res, 500, { message: `Surface Studio failed handling ${url}: ${message}${stale}` });
}

/** A real "nobody answered", as opposed to a bug in this process. */
function isConnectionFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Undici wraps the syscall error in `cause`; the code is what identifies it.
  const code = (err as { cause?: { code?: unknown } }).cause?.code;
  if (typeof code === "string") {
    return ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EHOSTUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(
      code,
    );
  }
  return err.name === "AbortError" || /fetch failed/i.test(err.message);
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

  // Deliberately does NOT touch the control plane: no project, no artifacts, no
  // run. A designer should be able to see what a frame compiles to with only
  // the board running.
  if (path === "/v1/preview" && req.method === "POST") {
    await previewCompile(req, res);
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

  if (path === "/v1/compile" && req.method === "POST") {
    await startCompile(config, req, res);
    return;
  }

  if (path.startsWith("/v1/preview/") && req.method === "GET") {
    await servePreview(config, path.slice("/v1/preview/".length), url, res);
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
 * Compile a frame and render it, with nothing persisted.
 *
 * A compile failure is the INTERESTING answer here, not an error to swallow:
 * "this frame has a text layer with no resolvable style" is precisely what the
 * designer opened the preview to find out. So a throw comes back as a 422 with
 * the message, and the panel shows it.
 */
async function previewCompile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    json(res, 400, { message: "body is not JSON" });
    return;
  }

  const body = previewRequestSchema.safeParse(parsed);
  if (!body.success) {
    json(res, 400, { message: body.error.issues[0]?.message ?? "invalid preview request" });
    return;
  }

  try {
    const result = await compilePreview({
      ir: body.data.ir,
      theme: body.data.theme,
      assets: body.data.assets,
      ...(body.data.width ? { width: body.data.width } : {}),
      ...(body.data.data ? { data: body.data.data } : {}),
    });
    json(res, 200, result);
  } catch (err) {
    json(res, 422, { message: err instanceof Error ? err.message : String(err) });
  }
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

/**
 * Turn a received export into a pipeline run: IR -> DSL, versioned, gated.
 *
 * Three control-plane calls stand between "there is an export" and "there is a
 * run", and the board should not know about any of them:
 *
 *   1. the theme. A run takes a `token_set` artifact by id, and the newest one
 *      in the project is the only sane default. There is no theme picker yet.
 *   2. the surface. `POST /runs` 404s on an unknown `surfaceKey`, so the record
 *      is created first; an already-existing one is a 409 and perfectly fine.
 *   3. the promotion. Writing `promoted_run_id` back onto the export is what
 *      makes the link outlive a reload — the board re-reads it from Postgres
 *      rather than holding the run id in component state.
 *
 * Idempotent by export: clicking twice returns the first run rather than
 * queueing a second compile of identical inputs.
 */
async function startCompile(
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

  const body = compileRequestSchema.safeParse(parsed);
  if (!body.success) {
    json(res, 400, { message: body.error.issues[0]?.message ?? "invalid compile request" });
    return;
  }

  const base = `${config.apiUrl}/v1/projects/${encodeURIComponent(config.projectRef)}`;
  const headers = { "content-type": "application/json", ...authHeaders(config) };

  const themeArtifact = await newestTokenSet(base, headers);
  if (!themeArtifact) {
    json(res, 422, {
      message:
        "no token_set artifact in this project — upload a theme before compiling: " +
        "POST /v1/projects/<project>/artifacts {kind:'token_set', json:<theme>}",
    });
    return;
  }

  // 409 means someone already created it, which is the outcome we wanted.
  const surface = await fetch(`${base}/surfaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ key: body.data.surfaceKey, name: body.data.surfaceName }),
  });
  if (!surface.ok && surface.status !== 409) {
    res.statusCode = surface.status;
    res.setHeader("Content-Type", "application/json");
    res.end(await surface.text());
    return;
  }

  /**
   * The marked backgrounds, by name and artifact.
   *
   * Ingest stored the bytes and recorded the join on the export; the run needs
   * it to turn `asset.texture.x` into a URL. Without it every marked image
   * comes back unresolved and the page renders without its plates — which is
   * exactly what happened before this lookup existed, except the pipeline then
   * papered over it with a hardcoded stand-in URL.
   */
  const assets = await assetsForExport(base, headers, body.data.exportId);

  const run = await fetch(`${base}/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "pipeline",
      input: {
        surfaceKey: body.data.surfaceKey,
        irArtifact: body.data.irArtifact,
        themeArtifact,
        assets,
      },
      // Omitted on force: no key means the control plane cannot dedupe it
      // against the previous run, which is exactly what a recompile wants.
      ...(body.data.force
        ? {}
        : { idempotencyKey: `studio-compile-${body.data.exportId}` }),
    }),
  });

  const runText = await run.text();
  if (!run.ok) {
    res.statusCode = run.status;
    res.setHeader("Content-Type", "application/json");
    res.end(runText);
    return;
  }

  const runId = (JSON.parse(runText) as { id?: string }).id;

  // Best effort: the run is already queued, and failing the request now would
  // tell the designer nothing useful happened when in fact it did.
  if (runId) {
    await fetch(`${base}/exports/${encodeURIComponent(body.data.exportId)}/status`, {
      method: "POST",
      headers,
      body: JSON.stringify({ status: "promoted", runId }),
    }).catch(() => null);
  }

  json(res, 202, { runId, themeArtifact, surfaceKey: body.data.surfaceKey });
}

/**
 * Render a finished run's compiled tree as a page.
 *
 * Everything needed is reachable from the run itself: `input.themeArtifact` is
 * the theme it was compiled against, and the `compile` step's output artifact
 * is the tree. Reading both from the run rather than from the project's current
 * state is what makes an old preview show what that run actually produced.
 */
async function servePreview(
  config: StudioConfig,
  runId: string,
  url: string,
  res: ServerResponse,
): Promise<void> {
  const base = `${config.apiUrl}/v1/projects/${encodeURIComponent(config.projectRef)}`;
  const headers = authHeaders(config);
  const query = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");

  const runResponse = await fetch(`${base}/runs/${encodeURIComponent(runId)}`, { headers });
  if (!runResponse.ok) {
    previewError(res, runResponse.status, `run ${runId} could not be read`);
    return;
  }

  const run = (await runResponse.json()) as {
    status?: string;
    input?: { themeArtifact?: string };
    steps?: Array<{
      name?: string;
      outputArtifactId?: string | null;
      detail?: { surfaceSetArtifact?: string };
    }>;
  };

  const compileStep = run.steps?.find((s) => s.name === "compile");
  const dslArtifact = compileStep?.outputArtifactId;
  const themeArtifact = run.input?.themeArtifact;
  // Runs from before the pipeline stored one have no surface set. They render
  // without plates rather than failing — the trace still says what happened.
  const surfaceArtifact = compileStep?.detail?.surfaceSetArtifact;

  if (!dslArtifact || !themeArtifact) {
    previewError(
      res,
      409,
      run.status === "succeeded"
        ? "this run produced no compiled tree"
        : `run is ${run.status ?? "unknown"} — nothing to preview yet`,
    );
    return;
  }

  const [tree, theme, surfaces] = await Promise.all([
    readJsonArtifact(base, headers, dslArtifact),
    readJsonArtifact(base, headers, themeArtifact),
    surfaceArtifact ? readJsonArtifact(base, headers, surfaceArtifact) : Promise.resolve(null),
  ]);

  try {
    const width = Number(query.get("width"));
    const { html } = await renderPreview({
      tree,
      theme,
      ...(surfaces ? { surfaces } : {}),
      ...(Number.isFinite(width) && width > 0 ? { width } : {}),
      ...(query.get("bg") ? { background: `#${query.get("bg")}` } : {}),
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // The tree is immutable, but the renderer is not — a rebuilt SDK must show
    // up on reload rather than being served from a stale cache.
    res.setHeader("Cache-Control", "no-store");
    res.end(html);
  } catch (err) {
    // A tree the renderer refuses is the interesting case: `reify` throws on a
    // malformed tree, and that message is the whole diagnosis.
    previewError(res, 422, err instanceof Error ? err.message : String(err));
  }
}

async function readJsonArtifact(
  base: string,
  headers: Record<string, string>,
  ref: string,
): Promise<unknown> {
  const response = await fetch(`${base}/artifacts/${encodeURIComponent(ref)}/content`, { headers });
  if (!response.ok) throw new Error(`artifact ${ref} could not be read (${response.status})`);
  return response.json();
}

/** A readable page, not JSON: this lands inside an iframe where JSON is invisible. */
function previewError(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(
    `<!DOCTYPE html><meta charset="utf-8" />` +
      `<body style="margin:0;padding:20px;background:#faf7ef;color:#9a3b2f;` +
      `font:12px/1.6 ui-monospace,monospace">${escapeHtml(message)}</body>`,
  );
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
}

/** Fonts and surface textures, straight out of the renderer package. */
function servePublicAsset(path: string, res: ServerResponse, next: () => void): void {
  let asset: { path: string; type: string } | null = null;
  try {
    asset = resolvePublicAsset(path);
  } catch {
    asset = null;
  }

  if (!asset) {
    next();
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", asset.type);
  res.setHeader("Cache-Control", "public, max-age=3600");
  createReadStream(asset.path).pipe(res);
}

/**
 * The export's marked backgrounds, as the run wants them.
 *
 * Best effort: a frame with no marks has none, and a lookup that fails should
 * not stop a compile that would otherwise succeed. The run records every ref it
 * could not resolve, so an empty list here surfaces there rather than vanishing.
 */
async function assetsForExport(
  base: string,
  headers: Record<string, string>,
  exportId: string,
): Promise<Array<{ name: string; artifactId: string }>> {
  const response = await fetch(`${base}/exports/${encodeURIComponent(exportId)}`, {
    headers,
  }).catch(() => null);
  if (!response?.ok) return [];

  const body = (await response.json().catch(() => null)) as {
    assets?: Array<{ name?: unknown; artifactId?: unknown }>;
  } | null;

  return (body?.assets ?? []).flatMap((asset) =>
    typeof asset.name === "string" && typeof asset.artifactId === "string"
      ? [{ name: asset.name, artifactId: asset.artifactId }]
      : [],
  );
}

/** The newest `token_set` in the project, or null if the project has none. */
async function newestTokenSet(
  base: string,
  headers: Record<string, string>,
): Promise<string | null> {
  const response = await fetch(`${base}/artifacts?kind=token_set&limit=1`, { headers });
  if (!response.ok) return null;

  const body = (await response.json()) as { artifacts?: Array<{ id?: string }> };
  return body.artifacts?.[0]?.id ?? null;
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
