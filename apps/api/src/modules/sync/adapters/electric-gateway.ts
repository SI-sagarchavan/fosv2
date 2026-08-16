/**
 * HTTP adapter for `SyncGateway`.
 *
 * Two details are load-bearing:
 *
 *   - A `live=true` request long-polls; Electric holds it open until something
 *     changes or it times out. So there is no client-side timeout here, only
 *     the caller's abort signal — a timeout would turn a healthy idle
 *     subscription into a reconnect storm.
 *   - 409 is not an error. Electric returns it when a shape has rotated, with
 *     the new handle in the body, and the client is expected to follow it. It
 *     must be relayed rather than swallowed.
 */
import { AppError } from "../../../kernel/errors.js";
import type { ShapeResponse, SyncGateway } from "../domain/ports.js";
import { PASSTHROUGH_HEADERS, toSearchParams, type ShapeDefinition } from "../domain/shape.js";

export function createElectricGateway(baseUrl: string): SyncGateway {
  const root = baseUrl.replace(/\/+$/, "");

  return {
    async fetchShape(shape: ShapeDefinition, signal?: AbortSignal): Promise<ShapeResponse> {
      const url = `${root}/v1/shape?${toSearchParams(shape).toString()}`;

      let response: Response;
      try {
        response = await fetch(url, { ...(signal ? { signal } : {}) });
      } catch (err) {
        if (signal?.aborted) {
          // The client hung up mid-long-poll. Routine, not a failure.
          throw new AppError("bad_request", "sync request aborted");
        }
        throw AppError.internal("sync backend unreachable", {
          cause: err instanceof Error ? err.message : String(err),
        });
      }

      const headers: Record<string, string> = {};
      for (const name of PASSTHROUGH_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }

      return {
        status: response.status,
        headers,
        body: new Uint8Array(await response.arrayBuffer()),
      };
    },
  };
}
