/**
 * The sync use case: authorize, scope, forward.
 *
 * Three lines of policy, and all three matter. The ownership check is what
 * stops a client from naming any run uuid; the derived `where` is what stops it
 * from widening the shape; the header passthrough is what makes resumption work
 * at all.
 */
import { AppError } from "../../../kernel/errors.js";
import type { RunOwnership, ShapeResponse, SyncGateway } from "../domain/ports.js";
import { isRunScoped, shapeForProject, shapeForRun, type SyncQuery } from "../domain/shape.js";

export interface SyncServiceDeps {
  gateway: SyncGateway;
  runs: RunOwnership;
}

export class SyncService {
  constructor(private readonly deps: SyncServiceDeps) {}

  async shape(projectId: string, query: SyncQuery, signal?: AbortSignal): Promise<ShapeResponse> {
    const cursor = {
      offset: query.offset,
      live: query.live,
      ...(query.handle ? { handle: query.handle } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    };

    let shape;
    if (isRunScoped(query.table)) {
      // `SyncQuery` guarantees a run for these tables; this narrows the type.
      const runId = query.run;
      if (!runId) throw AppError.badRequest(`table "${query.table}" requires ?run=`);

      // 404 rather than 403: a caller who guessed a uuid from another tenant
      // learns nothing about whether it exists.
      const owned = await this.deps.runs.belongsToProject(runId, projectId);
      if (!owned) throw AppError.notFound("run", runId);

      shape = shapeForRun(query.table, { runId, projectId, cursor });
    } else {
      // Project-scoped. The project id was resolved and authorized by the
      // route before we got here, so it is the whole boundary.
      shape = shapeForProject(query.table, { projectId, cursor });
    }

    return this.deps.gateway.fetchShape(shape, signal);
  }
}
