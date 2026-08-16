import type { ShapeDefinition } from "./shape.js";

/** What Electric answered, reduced to what the proxy needs to relay. */
export interface ShapeResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface SyncGateway {
  fetchShape(shape: ShapeDefinition, signal?: AbortSignal): Promise<ShapeResponse>;
}

/** What sync needs from runs: proof this run belongs to this project. */
export interface RunOwnership {
  belongsToProject(runId: string, projectId: string): Promise<boolean>;
}
