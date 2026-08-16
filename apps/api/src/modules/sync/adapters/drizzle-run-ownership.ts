import { and, eq } from "drizzle-orm";

import type { Db } from "../../../platform/db/client.js";
import { runs } from "../../../platform/db/schema.js";
import type { RunOwnership } from "../domain/ports.js";

/** One indexed lookup per subscription request, not per streamed change. */
export class DrizzleRunOwnership implements RunOwnership {
  constructor(private readonly db: Db) {}

  async belongsToProject(runId: string, projectId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.projectId, projectId)))
      .limit(1);

    return rows.length > 0;
  }
}
