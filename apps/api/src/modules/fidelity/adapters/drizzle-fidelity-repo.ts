import { desc, eq } from "drizzle-orm";

import { AppError } from "../../../kernel/errors.js";
import type { Db } from "../../../platform/db/client.js";
import { fidelityReports, type FidelityReportRow } from "../../../platform/db/schema.js";
import type { FidelityReport, FindingSummary, Thresholds } from "../domain/gate.js";
import type { FidelityRepository, NewFidelityReport } from "../domain/ports.js";

export class DrizzleFidelityRepository implements FidelityRepository {
  constructor(private readonly db: Db) {}

  async record(input: NewFidelityReport): Promise<FidelityReport> {
    const rows = await this.db
      .insert(fidelityReports)
      .values(input)
      .onConflictDoUpdate({
        target: [fidelityReports.runId, fidelityReports.surfaceVersionId],
        // Everything except the conflict target: a retried run replaces its own
        // verdict rather than stacking a second one.
        set: {
          passed: input.passed,
          score: input.score,
          thresholds: input.thresholds,
          findings: input.findings,
          reportArtifactId: input.reportArtifactId,
        },
      })
      .returning();

    const row = rows[0];
    if (!row) throw AppError.internal("fidelity write returned no row");
    return toReport(row);
  }

  async latestForVersion(surfaceVersionId: string): Promise<FidelityReport | null> {
    const rows = await this.db
      .select()
      .from(fidelityReports)
      .where(eq(fidelityReports.surfaceVersionId, surfaceVersionId))
      .orderBy(desc(fidelityReports.createdAt))
      .limit(1);
    return rows[0] ? toReport(rows[0]) : null;
  }

  async listForRun(runId: string): Promise<FidelityReport[]> {
    const rows = await this.db
      .select()
      .from(fidelityReports)
      .where(eq(fidelityReports.runId, runId))
      .orderBy(desc(fidelityReports.createdAt));
    return rows.map(toReport);
  }
}

function toReport(row: FidelityReportRow): FidelityReport {
  return {
    id: row.id,
    runId: row.runId,
    surfaceVersionId: row.surfaceVersionId,
    passed: row.passed,
    score: row.score,
    thresholds: row.thresholds as Thresholds,
    findings: row.findings as FindingSummary[],
    reportArtifactId: row.reportArtifactId,
    createdAt: row.createdAt,
  };
}
