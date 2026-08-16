/**
 * Postgres adapter for `ExportRepository` and `FigmaFileDirectory`.
 */
import { and, desc, eq, type SQL } from "drizzle-orm";

import { AppError } from "../../../kernel/errors.js";
import type { Db } from "../../../platform/db/client.js";
import {
  figmaExportPlates,
  figmaExports,
  projectFigmaFiles,
  type FigmaExportPlateRow,
  type FigmaExportRow,
} from "../../../platform/db/schema.js";
import type {
  ExportPlate,
  ExportStatus,
  FigmaExport,
  ListExportsQuery,
} from "../domain/export.js";
import type {
  ExportRepository,
  FigmaFileDirectory,
  NewExport,
  NewPlate,
} from "../domain/ports.js";

export class DrizzleExportRepository implements ExportRepository {
  constructor(private readonly db: Db) {}

  async create(
    input: NewExport,
    plates: readonly NewPlate[],
  ): Promise<{ export: FigmaExport; plates: ExportPlate[]; created: boolean }> {
    const outcome = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(figmaExports)
        .values({
          projectId: input.projectId,
          fileKey: input.fileKey,
          fileName: input.fileName,
          pageName: input.pageName,
          rootNodeId: input.rootNodeId,
          rootName: input.rootName,
          irArtifactId: input.irArtifactId,
          nodeCount: input.health.nodeCount,
          boundCount: input.health.boundCount,
          looseCount: input.health.looseCount,
          coveragePercent: input.health.coveragePercent,
          schemaValid: input.health.schemaValid,
          summary: input.summary,
          structuralSignature: input.structuralSignature,
          canonicalSignature: input.canonicalSignature,
          idempotencyKey: input.idempotencyKey,
          exportedAt: input.exportedAt,
          exportedBy: input.exportedBy,
        })
        // A retried send is a read, not an error the caller has to classify.
        .onConflictDoNothing({
          target: [figmaExports.projectId, figmaExports.idempotencyKey],
        })
        .returning();

      const row = inserted[0];
      if (!row) return { row: null, created: false };

      if (plates.length > 0) {
        // Same transaction as the export: a half-landed set would tell the
        // diff step it has reference images it does not have.
        await tx
          .insert(figmaExportPlates)
          .values(plates.map((p) => ({ ...p, exportId: row.id, projectId: input.projectId })));
      }

      return { row, created: true };
    });

    if (outcome.row) {
      return {
        export: toExport(outcome.row),
        plates: await this.platesFor(outcome.row.id),
        created: true,
      };
    }

    const existing = await this.findByIdempotencyKey(input.projectId, input.idempotencyKey);
    if (!existing) throw AppError.internal("export insert conflicted but no row was found");

    return { export: existing, plates: await this.platesFor(existing.id), created: false };
  }

  async findById(projectId: string, id: string): Promise<FigmaExport | null> {
    const rows = await this.db
      .select()
      .from(figmaExports)
      .where(and(eq(figmaExports.projectId, projectId), eq(figmaExports.id, id)))
      .limit(1);
    return rows[0] ? toExport(rows[0]) : null;
  }

  async platesFor(exportId: string): Promise<ExportPlate[]> {
    const rows = await this.db
      .select()
      .from(figmaExportPlates)
      .where(eq(figmaExportPlates.exportId, exportId))
      .orderBy(figmaExportPlates.seq);
    return rows.map(toPlate);
  }

  async list(projectId: string, query: ListExportsQuery): Promise<FigmaExport[]> {
    const filters: SQL[] = [eq(figmaExports.projectId, projectId)];
    if (query.status) filters.push(eq(figmaExports.status, query.status));
    if (query.rootNodeId) filters.push(eq(figmaExports.rootNodeId, query.rootNodeId));

    const rows = await this.db
      .select()
      .from(figmaExports)
      .where(and(...filters))
      .orderBy(desc(figmaExports.receivedAt))
      .limit(query.limit);
    return rows.map(toExport);
  }

  async latestForFrame(projectId: string, rootNodeId: string): Promise<FigmaExport | null> {
    const rows = await this.db
      .select()
      .from(figmaExports)
      .where(
        and(eq(figmaExports.projectId, projectId), eq(figmaExports.rootNodeId, rootNodeId)),
      )
      .orderBy(desc(figmaExports.receivedAt))
      .limit(1);
    return rows[0] ? toExport(rows[0]) : null;
  }

  async setStatus(
    projectId: string,
    id: string,
    status: ExportStatus,
    promotedRunId: string | null,
  ): Promise<FigmaExport | null> {
    const rows = await this.db
      .update(figmaExports)
      .set({ status, promotedRunId })
      .where(and(eq(figmaExports.projectId, projectId), eq(figmaExports.id, id)))
      .returning();
    return rows[0] ? toExport(rows[0]) : null;
  }

  private async findByIdempotencyKey(
    projectId: string,
    key: string,
  ): Promise<FigmaExport | null> {
    const rows = await this.db
      .select()
      .from(figmaExports)
      .where(
        and(eq(figmaExports.projectId, projectId), eq(figmaExports.idempotencyKey, key)),
      )
      .limit(1);
    return rows[0] ? toExport(rows[0]) : null;
  }
}

export class DrizzleFigmaFileDirectory implements FigmaFileDirectory {
  constructor(private readonly db: Db) {}

  async projectIdForFile(fileKey: string): Promise<string | null> {
    const rows = await this.db
      .select({ projectId: projectFigmaFiles.projectId })
      .from(projectFigmaFiles)
      .where(eq(projectFigmaFiles.fileKey, fileKey))
      .limit(1);
    return rows[0]?.projectId ?? null;
  }

  async claim(projectId: string, fileKey: string, fileName: string | null): Promise<void> {
    await this.db
      .insert(projectFigmaFiles)
      .values({ projectId, fileKey, fileName })
      .onConflictDoNothing({ target: [projectFigmaFiles.fileKey] });
  }
}

function toExport(row: FigmaExportRow): FigmaExport {
  return {
    id: row.id,
    projectId: row.projectId,
    fileKey: row.fileKey,
    fileName: row.fileName,
    pageName: row.pageName,
    rootNodeId: row.rootNodeId,
    rootName: row.rootName,
    irArtifactId: row.irArtifactId,
    health: {
      nodeCount: row.nodeCount,
      boundCount: row.boundCount,
      looseCount: row.looseCount,
      coveragePercent: row.coveragePercent,
      schemaValid: row.schemaValid,
    },
    summary: row.summary as Record<string, unknown>,
    structuralSignature: row.structuralSignature,
    canonicalSignature: row.canonicalSignature,
    status: row.status,
    promotedRunId: row.promotedRunId,
    surfaceId: row.surfaceId,
    idempotencyKey: row.idempotencyKey,
    exportedAt: row.exportedAt,
    receivedAt: row.receivedAt,
    exportedBy: row.exportedBy,
  };
}

function toPlate(row: FigmaExportPlateRow): ExportPlate {
  return {
    id: row.id,
    exportId: row.exportId,
    artifactId: row.artifactId,
    nodeId: row.nodeId,
    name: row.name,
    seq: row.seq,
  };
}
