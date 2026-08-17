/**
 * The outbound client. Pure: fetch is a fake, so a down dashboard cannot
 * make these fail, and they do not need Figma.
 */
import { describe, expect, it, vi } from "vitest";
import {
  API_TIMEOUT_MS,
  buildExportBody,
  bytesToBase64,
  createApiClient,
  DEFAULT_API_ORIGIN,
  EVENTS_PATH,
  EXPORT_TIMEOUT_MS,
  EXPORTS_PATH,
  HEALTH_PATH,
  normalizeOrigin,
  resolveOrigin,
  type ApiFetchResponse,
  type StudioEvent,
} from "../src/api/index.js";

function jsonResponse(status: number, body: unknown): ApiFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const event: StudioEvent = {
  type: "page.checked",
  at: 1,
  page: {
    fileKey: "abc",
    fileName: "Southern Brave",
    pageName: "Home",
    rootNodeId: "1:2",
    rootName: "Home",
  },
  payload: { percent: 53.9 },
};

describe("resolveOrigin", () => {
  it("defaults when nothing is stored", () => {
    expect(resolveOrigin(undefined)).toBe(DEFAULT_API_ORIGIN);
    expect(resolveOrigin("")).toBe(DEFAULT_API_ORIGIN);
  });

  it("ignores a host that is not on the allowlist", () => {
    expect(resolveOrigin("http://127.0.0.1:3000")).toBe(DEFAULT_API_ORIGIN);
    expect(resolveOrigin("https://evil.example")).toBe(DEFAULT_API_ORIGIN);
  });

  it("strips a trailing slash before comparing", () => {
    expect(normalizeOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
  });
});

describe("createApiClient", () => {
  it("GETs /v1/health", async () => {
    const fetch = vi.fn(async () => jsonResponse(200, { ok: true }));
    const client = createApiClient({ origin: DEFAULT_API_ORIGIN, fetch });
    const result = await client.ping();
    expect(result).toEqual({ ok: true, status: 200, data: { ok: true } });
    expect(fetch).toHaveBeenCalledWith(`${DEFAULT_API_ORIGIN}${HEALTH_PATH}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  });

  it("POSTs the event envelope to /v1/events", async () => {
    const fetch = vi.fn(async () => jsonResponse(202, { id: "e1" }));
    const client = createApiClient({ origin: DEFAULT_API_ORIGIN, fetch });
    const result = await client.postEvent(event);
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith(`${DEFAULT_API_ORIGIN}${EVENTS_PATH}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
  });

  it("turns a 4xx into a result, not a throw", async () => {
    const fetch = vi.fn(async () => jsonResponse(400, { message: "unknown page" }));
    const client = createApiClient({ origin: DEFAULT_API_ORIGIN, fetch });
    await expect(client.postEvent(event)).resolves.toEqual({
      ok: false,
      status: 400,
      message: "unknown page",
    });
  });

  it("turns a network failure into a result, not a throw", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });
    const client = createApiClient({ origin: DEFAULT_API_ORIGIN, fetch });
    await expect(client.ping()).resolves.toEqual({
      ok: false,
      status: null,
      message: "Failed to fetch",
    });
  });

  it("times out rather than wait on a hung dashboard", async () => {
    const fetch = vi.fn(() => new Promise<ApiFetchResponse>(() => {}));
    const client = createApiClient({ origin: DEFAULT_API_ORIGIN, fetch, timeoutMs: 20 });
    const result = await client.ping();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/timed out/);
  });

  it("uses the default timeout when none is passed", () => {
    expect(API_TIMEOUT_MS).toBe(4000);
    expect(EXPORT_TIMEOUT_MS).toBe(60_000);
  });

  it("POSTs the export body to /v1/exports", async () => {
    const fetch = vi.fn(async (_url: string, init: { body?: string }) => {
      expect(JSON.parse(init.body ?? "{}").jsonName).toBe("Home-1-2.ir.json");
      return jsonResponse(202, { id: "exp1" });
    });
    const client = createApiClient({ origin: DEFAULT_API_ORIGIN, fetch });
    const body = buildExportBody({
      page: event.page,
      at: 1,
      jsonName: "Home-1-2.ir.json",
      json: '{"ok":true}',
      summary: { nodeCount: 2 },
      screenshots: [{ name: "hero-1-3.png", nodeId: "1:3", bytes: new Uint8Array([1, 2, 3]) }],
    });
    const result = await client.postExport(body);
    expect(result.ok).toBe(true);
    expect(fetch.mock.calls[0]?.[0]).toBe(`${DEFAULT_API_ORIGIN}${EXPORTS_PATH}`);
  });
});

describe("buildExportBody", () => {
  it("parses the IR and base64-encodes each PNG", () => {
    const body = buildExportBody({
      page: event.page,
      at: 9,
      jsonName: "Home-1-2.ir.json",
      json: '{"root":{"id":"1:2"}}',
      summary: { nodeCount: 1 },
      screenshots: [{ name: "hero.png", nodeId: "1:3", bytes: new Uint8Array([0x89, 0x50]) }],
    });
    expect(body.ir).toEqual({ root: { id: "1:2" } });
    expect(body.screenshots[0]).toEqual({
      name: "hero.png",
      nodeId: "1:3",
      bytesBase64: bytesToBase64(new Uint8Array([0x89, 0x50])),
    });
    expect(body.assets).toEqual([]);
  });

  it("encodes marked background assets next to the plates", () => {
    const body = buildExportBody({
      page: event.page,
      at: 9,
      jsonName: "Home-1-2.ir.json",
      json: "{}",
      summary: {},
      screenshots: [],
      assets: [
        {
          name: "tickets_plate",
          nodeId: "1:10",
          targetNodeId: "1:2",
          role: "background",
          bytes: new Uint8Array([0x89, 0x50]),
          source: "original",
        },
      ],
    });
    expect(body.assets).toEqual([
      {
        name: "tickets_plate",
        nodeId: "1:10",
        targetNodeId: "1:2",
        role: "background",
        source: "original",
        bytesBase64: bytesToBase64(new Uint8Array([0x89, 0x50])),
      },
    ]);
  });

  it("keeps ir null when the JSON is broken rather than throwing", () => {
    const body = buildExportBody({
      page: event.page,
      at: 1,
      jsonName: "bad.ir.json",
      json: "{",
      summary: {},
      screenshots: [],
    });
    expect(body.ir).toBeNull();
  });
});

describe("bytesToBase64", () => {
  it("matches the RFC 4648 vectors", () => {
    const enc = (text: string) => bytesToBase64(new TextEncoder().encode(text));
    expect(enc("")).toBe("");
    expect(enc("f")).toBe("Zg==");
    expect(enc("fo")).toBe("Zm8=");
    expect(enc("foo")).toBe("Zm9v");
  });
});
