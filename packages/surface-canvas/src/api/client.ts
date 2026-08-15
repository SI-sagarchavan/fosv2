/**
 * Outbound HTTP for Surface Studio.
 *
 * Themes stay compiled in. This exists so the sandbox can post a page event
 * without the panel growing a second product. `fetch` is injected — the only
 * Figma-aware call is the one `main.ts` makes when it constructs a client.
 *
 * A down dashboard must never stall a lint. Every method returns an
 * {@link ApiResult}; nothing here throws into the session.
 *
 * PURE.
 */
import type { ApiFetch, ApiResult, StudioEvent, StudioExport } from "./types.js";

export const API_TIMEOUT_MS = 4000;
/** IR + PNGs are a real upload. A 4s hang-up would drop a finished walk. */
export const EXPORT_TIMEOUT_MS = 60_000;
export const EVENTS_PATH = "/v1/events";
export const HEALTH_PATH = "/v1/health";
export const EXPORTS_PATH = "/v1/exports";

export interface ApiClient {
  readonly origin: string;
  ping(): Promise<ApiResult>;
  postEvent(event: StudioEvent): Promise<ApiResult>;
  postExport(body: StudioExport): Promise<ApiResult>;
}

export function createApiClient(options: {
  origin: string;
  fetch: ApiFetch;
  timeoutMs?: number;
}): ApiClient {
  const origin = options.origin.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? API_TIMEOUT_MS;

  const request = async (
    method: string,
    path: string,
    body?: unknown,
    limitMs = timeoutMs,
  ): Promise<ApiResult> => {
    const url = `${origin}${path.startsWith("/") ? path : `/${path}`}`;
    const init: Parameters<ApiFetch>[1] = {
      method,
      headers: { Accept: "application/json" },
    };
    if (body !== undefined) {
      init.headers = { ...init.headers, "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }

    try {
      const response = await withTimeout(options.fetch(url, init), limitMs);
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          message: (await readMessage(response)) || `${response.status} ${response.statusText}`.trim(),
        };
      }
      return { ok: true, status: response.status, data: await readData(response) };
    } catch (err) {
      return { ok: false, status: null, message: errorMessage(err) };
    }
  };

  return {
    origin,
    ping: () => request("GET", HEALTH_PATH),
    postEvent: (event) => request("POST", EVENTS_PATH, event),
    postExport: (body) => request("POST", EXPORTS_PATH, body, EXPORT_TIMEOUT_MS),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`API timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function readData(response: { json(): Promise<unknown>; text(): Promise<string> }): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    try {
      const text = await response.text();
      return text === "" ? null : text;
    } catch {
      return null;
    }
  }
}

async function readMessage(response: {
  json(): Promise<unknown>;
  text(): Promise<string>;
}): Promise<string> {
  const data = await readData(response);
  if (data && typeof data === "object" && "message" in data && typeof data.message === "string") {
    return data.message;
  }
  if (typeof data === "string" && data.trim()) return data.trim();
  return "";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}
