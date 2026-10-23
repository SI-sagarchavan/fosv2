/**
 * The inspector's HTTP surface. Thin on purpose: resolve the inputs, call
 * `inspect` / `analyzeBindings`, say what went wrong in words.
 *
 *   POST /v1/inspect              IR + theme -> the DSL, the join, the gaps
 *   POST /v1/bindings             + a sample payload and plan -> refs, suggestions, render
 *   GET  /v1/datasets[/:name]     named sample datasets the control plane serves
 *   POST /v1/exports/:id/status   dismiss / restore a board row
 *
 * The first two work with ONLY this process running: pass `ir` by value and the
 * theme falls back to the repo's fixture. A designer can see what a frame
 * compiles to without Postgres, Redis or the worker — which is also how this was
 * built and tested. The result says which theme it used, so a fallback is never
 * silent.
 */
import { readFileSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";

import type { z } from "zod";

import { authHeaders, type StudioConfig } from "./config.js";
import { analyzeBindings } from "./bindings.js";
import { inspect } from "./inspect.js";
import { bindingsRequestSchema, exportStatusRequestSchema, inspectRequestSchema } from "./schema.js";

/** What plugin-api already has, handed over rather than imported (it imports us). */
export interface RouteHelpers {
  readBody(req: IncomingMessage): Promise<string>;
  json(res: ServerResponse, status: number, body: unknown): void;
  readJsonArtifact(base: string, headers: Record<string, string>, ref: string): Promise<unknown>;
  readData(base: string, headers: Record<string, string>, ref: string | null | undefined): Promise<unknown>;
  newestTokenSet(base: string, headers: Record<string, string>): Promise<string | null>;
}

/** @returns true when the request was ours. */
export async function handleInspectRoutes(
  config: StudioConfig,
  helpers: RouteHelpers,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const base = `${config.apiUrl}/v1/projects/${encodeURIComponent(config.projectRef)}`;
  const headers = authHeaders(config);

  if (path === "/v1/inspect" && req.method === "POST") {
    const parsed = await parseBody(helpers, req, res, inspectRequestSchema);
    if (!parsed) return true;

    try {
      const ir = parsed.ir ?? (await helpers.readJsonArtifact(base, headers, parsed.irArtifact as string));
      const theme = await resolveTheme(config, helpers, base, headers, parsed);
      const result = await inspect({
        ir,
        theme: theme.raw,
        themeSource: theme.source,
        render: parsed.render,
        ...(parsed.width ? { width: parsed.width } : {}),
        ...(parsed.icons ? { icons: parsed.icons } : {}),
      });
      helpers.json(res, 200, result);
    } catch (err) {
      // A compile failure is an ANSWER here — "this frame has a layer the
      // compiler cannot read" is what the page was opened to learn.
      helpers.json(res, 422, { message: explain(err) });
    }
    return true;
  }

  if (path === "/v1/bindings" && req.method === "POST") {
    const parsed = await parseBody(helpers, req, res, bindingsRequestSchema);
    if (!parsed) return true;

    try {
      const ir = parsed.ir ?? (await helpers.readJsonArtifact(base, headers, parsed.irArtifact as string));
      const theme = await resolveTheme(config, helpers, base, headers, parsed);
      const data =
        parsed.data ??
        (parsed.dataset ? ((await helpers.readData(base, headers, parsed.dataset)) as Record<string, unknown>) : undefined);

      const result = await analyzeBindings({
        ir,
        theme: theme.raw,
        render: parsed.render,
        ...(parsed.width ? { width: parsed.width } : {}),
        ...(parsed.icons ? { icons: parsed.icons } : {}),
        ...(data ? { data } : {}),
        ...(parsed.plan ? { plan: parsed.plan } : {}),
      });
      helpers.json(res, 200, { ...result, themeSource: theme.source });
    } catch (err) {
      helpers.json(res, 422, { message: explain(err) });
    }
    return true;
  }

  if (path === "/v1/datasets" && req.method === "GET") {
    const apiRoot = `${config.apiUrl}/v1`;
    const upstream = await fetch(`${apiRoot}/data`, { headers }).catch(() => null);
    if (!upstream?.ok) {
      // Not an error: no control plane just means no named datasets.
      helpers.json(res, 200, { datasets: [], available: false });
      return true;
    }
    const body = (await upstream.json()) as { datasets?: string[] };
    helpers.json(res, 200, { datasets: body.datasets ?? [], available: true });
    return true;
  }

  const datasetMatch = /^\/v1\/datasets\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (datasetMatch && req.method === "GET") {
    const upstream = await fetch(`${config.apiUrl}/v1/data/${datasetMatch[1]}`, { headers }).catch(() => null);
    if (!upstream) {
      helpers.json(res, 502, { message: "control plane unreachable" });
      return true;
    }
    res.statusCode = upstream.status;
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
    res.end(await upstream.text());
    return true;
  }

  const statusMatch = /^\/v1\/exports\/([^/]+)\/status$/.exec(path);
  if (statusMatch && req.method === "POST") {
    const parsed = await parseBody(helpers, req, res, exportStatusRequestSchema);
    if (!parsed) return true;

    const upstream = await fetch(`${base}/exports/${encodeURIComponent(statusMatch[1] as string)}/status`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ status: parsed.status }),
    });
    res.statusCode = upstream.status;
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
    res.end(await upstream.text());
    return true;
  }

  return false;
}

async function parseBody<T extends z.ZodTypeAny>(
  helpers: RouteHelpers,
  req: IncomingMessage,
  res: ServerResponse,
  schema: T,
): Promise<z.infer<T> | null> {
  const raw = await helpers.readBody(req);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    helpers.json(res, 400, { message: "body is not JSON" });
    return null;
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    helpers.json(res, 400, { message: result.error.issues[0]?.message ?? "invalid request" });
    return null;
  }
  return result.data;
}

/**
 * A Zod failure arrives as a JSON array in `message`, which in a red box is a
 * wall of brackets. Say which fields instead.
 */
function explain(err: unknown): string {
  const issues = (err as { issues?: Array<{ path: Array<string | number>; message: string }> } | null)?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const shown = issues.slice(0, 6).map((i) => `${i.path.join(".") || "(document)"}: ${i.message}`);
    const more = issues.length > shown.length ? ` … and ${issues.length - shown.length} more` : "";
    return `that is not a readable Frame IR document — ${shown.join("; ")}${more}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Inline theme, else the artifact asked for, else the project's newest, else the
 * repo's fixture. Each step falls to the next only on ABSENCE or an unreachable
 * control plane — a theme that was asked for by id and cannot be read is an
 * error, because rendering against a different one would be a quiet lie.
 */
async function resolveTheme(
  config: StudioConfig,
  helpers: RouteHelpers,
  base: string,
  headers: Record<string, string>,
  body: { theme?: unknown; themeArtifact?: string | undefined },
): Promise<{ raw: unknown; source: string }> {
  if (body.theme !== undefined) return { raw: body.theme, source: "sent with the request" };

  if (body.themeArtifact) {
    return {
      raw: await helpers.readJsonArtifact(base, headers, body.themeArtifact),
      source: `token_set ${body.themeArtifact.slice(0, 8)}`,
    };
  }

  try {
    const newest = await helpers.newestTokenSet(base, headers);
    if (newest) {
      return { raw: await helpers.readJsonArtifact(base, headers, newest), source: `newest token_set ${newest.slice(0, 8)}` };
    }
  } catch {
    // Control plane down. Fall through to the fixture; the source line says so.
  }

  const dir = resolve(process.cwd(), "../../packages/tokens/fixtures");
  const file = readdirSync(dir).filter((f) => f.endsWith(".json")).sort()[0];
  if (!file) {
    throw new Error("no theme: none sent, none in the control plane, and packages/tokens/fixtures is empty");
  }
  return { raw: JSON.parse(readFileSync(resolve(dir, file), "utf8")), source: `fixture ${file} (no token_set in the control plane)` };
}
