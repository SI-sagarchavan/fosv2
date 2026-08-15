/**
 * Turn a local export into the body Surface Studio accepts.
 *
 * The ZIP and the POST are the same files. This is the encoding step, not a
 * second extraction.
 *
 * PURE.
 */
import { bytesToBase64 } from "./base64.js";
import type { StudioExport, StudioPage } from "./types.js";

export function buildExportBody(input: {
  page: StudioPage;
  at: number;
  jsonName: string;
  json: string;
  summary: Record<string, unknown>;
  screenshots: ReadonlyArray<{ name: string; nodeId: string; bytes: Uint8Array }>;
}): StudioExport {
  let ir: unknown = null;
  try {
    ir = JSON.parse(input.json);
  } catch {
    ir = null;
  }

  return {
    page: input.page,
    at: input.at,
    jsonName: input.jsonName,
    ir,
    summary: input.summary,
    screenshots: input.screenshots.map((shot) => ({
      name: shot.name,
      nodeId: shot.nodeId,
      bytesBase64: bytesToBase64(shot.bytes),
    })),
  };
}
