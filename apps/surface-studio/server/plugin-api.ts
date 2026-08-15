/**
 * Vite middleware: the plugin's allowlisted origin is this server.
 *
 *   GET  /v1/health
 *   GET  /v1/exports
 *   POST /v1/exports
 *
 * CORS is open. The Figma sandbox fetch and a null-origin iframe both have
 * to land here; locking origin would fail one of them.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, ViteDevServer } from "vite";
import { studioExportSchema } from "./schema.js";
import { count, list, remember } from "./store.js";

export function surfaceStudioApi() {
  return {
    name: "surface-studio-api",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(handle);
    },
    configurePreviewServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(handle);
    },
  };
}

function handle(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  const url = req.url?.split("?")[0] ?? "";
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

  void route(url, req, res).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    json(res, 500, { message });
  });
}

async function route(url: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (url === "/v1/health" && req.method === "GET") {
    json(res, 200, { ok: true, listening: true, exports: count() });
    return;
  }

  if (url === "/v1/exports" && req.method === "GET") {
    json(res, 200, { exports: list().map(publicRow) });
    return;
  }

  if (url === "/v1/exports" && req.method === "POST") {
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
    const row = remember(body.data);
    json(res, 202, { id: row.id, at: row.receivedAt });
    return;
  }

  json(res, 404, { message: "not found" });
}

function publicRow(row: ReturnType<typeof list>[number]) {
  return {
    id: row.id,
    at: row.at,
    receivedAt: row.receivedAt,
    page: row.page,
    jsonName: row.jsonName,
    summary: row.summary,
    screenshots: row.screenshots.map((shot) => ({
      name: shot.name,
      nodeId: shot.nodeId,
      src: `data:image/png;base64,${shot.bytesBase64}`,
    })),
  };
}

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
