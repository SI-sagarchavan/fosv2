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
  assets?: ReadonlyArray<{
    name: string;
    nodeId: string;
    targetNodeId: string;
    role: "background";
    bytes: Uint8Array;
    source: "original" | "rendered";
  }>;
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
    assets: (input.assets ?? []).map((asset) => ({
      name: asset.name,
      nodeId: asset.nodeId,
      targetNodeId: asset.targetNodeId,
      role: asset.role,
      source: asset.source,
      bytesBase64: bytesToBase64(asset.bytes),
    })),
  };
}
