/**
 * The subset of fetch the sandbox and the tests both speak.
 *
 * Figma's `fetch` is not the WhatWG one: the URL must be a string, headers a
 * plain object, body a string or bytes. This type is that contract, so the
 * client never reaches for `Headers`, `URL`, or `AbortSignal` — none of which
 * the sandbox fetch options accept.
 */

export interface ApiFetchInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ApiFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type ApiFetch = (url: string, init: ApiFetchInit) => Promise<ApiFetchResponse>;

export type ApiResult<T = unknown> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number | null; message: string };

/** The board key. Same shape on events and on the export body. */
export interface StudioPage {
  fileKey: string | null;
  fileName: string;
  pageName: string;
  rootNodeId: string | null;
  rootName: string | null;
}

/**
 * One outbound event. The dashboard keys a board off `page`; `type` is the
 * verb. The plugin does not invent a second vocabulary here — Health already
 * named the moments (checked, bound, exported).
 */
export interface StudioEvent {
  type: string;
  at: number;
  page: StudioPage;
  payload: Record<string, unknown>;
}

/**
 * The production corpus row: the same IR + PNGs the ZIP would have held.
 * Screenshots travel as base64 because Figma's fetch body is a string.
 */
export interface StudioExport {
  page: StudioPage;
  at: number;
  jsonName: string;
  ir: unknown;
  summary: Record<string, unknown>;
  screenshots: Array<{ name: string; nodeId: string; bytesBase64: string }>;
}
