import type { ExportHealth, ExportPlate, ExportStatus, FigmaExport, ListExportsQuery } from "./export.js";

export interface NewExport {
  projectId: string;
  fileKey: string | null;
  fileName: string;
  pageName: string;
  rootNodeId: string | null;
  rootName: string | null;
  irArtifactId: string;
  health: ExportHealth;
  summary: Record<string, unknown>;
  structuralSignature: string | null;
  canonicalSignature: string | null;
  idempotencyKey: string;
  exportedAt: Date;
  exportedBy: string | null;
}

export interface NewPlate {
  artifactId: string;
  nodeId: string;
  name: string;
  seq: number;
}

export interface ExportRepository {
  /**
   * Insert the export and all its plates, or none of them.
   *
   * One method because it must be one transaction: an export row whose plates
   * half-landed would tell the diff step it has reference images it does not
   * have. Returns `created: false` when the idempotency key already exists, so
   * a retried send is a read rather than an error the caller must classify.
   */
  create(
    input: NewExport,
    plates: readonly NewPlate[],
  ): Promise<{ export: FigmaExport; plates: ExportPlate[]; created: boolean }>;

  findById(projectId: string, id: string): Promise<FigmaExport | null>;
  platesFor(exportId: string): Promise<ExportPlate[]>;
  list(projectId: string, query: ListExportsQuery): Promise<FigmaExport[]>;

  /** Most recent send of the same frame, for change detection. */
  latestForFrame(projectId: string, rootNodeId: string): Promise<FigmaExport | null>;

  setStatus(
    projectId: string,
    id: string,
    status: ExportStatus,
    promotedRunId: string | null,
  ): Promise<FigmaExport | null>;
}

/**
 * Which project a Figma file belongs to.
 *
 * Separate from the export repository because it answers a different question,
 * and because the ingest route needs it *before* it has anything to store —
 * an export for an unmapped file must be rejected, not stored and orphaned.
 */
export interface FigmaFileDirectory {
  projectIdForFile(fileKey: string): Promise<string | null>;
}
