/**
 * Ingest: turn a designer pressing Send into durable, content-addressed state.
 *
 * Ordering is the whole design, and it is the same rule the artifact store
 * already follows — **blobs first, rows second**. Artifacts written without an
 * export row are garbage a sweeper can collect; an export row pointing at
 * blobs that were never written is a broken record that breaks the board and
 * the diff step. We always leave the recoverable failure.
 *
 * The export and its plates go in together or not at all, because a half-landed
 * set would tell the pixel-diff gate it has reference images it does not have.
 */
import type { AuditSink } from "../../../kernel/audit.js";
import { AppError } from "../../../kernel/errors.js";
import {
  healthOf,
  idempotencyKeyFor,
  toExportView,
  type ExportStatus,
  type ExportView,
  type IngestExportCommand,
  type ListExportsQuery,
} from "../domain/export.js";
import type { ExportRepository, FigmaFileDirectory, NewPlate } from "../domain/ports.js";

/** What exports needs from the artifact store. Declared by the consumer. */
export interface ArtifactWriter {
  store(
    projectId: string,
    input: {
      kind: "figma_ir" | "screenshot";
      bytes: Uint8Array;
      mediaType?: string;
      meta?: Record<string, unknown>;
      actor?: string;
    },
  ): Promise<{ id: string; digest: string }>;
}

export interface ExportServiceDeps {
  repo: ExportRepository;
  files: FigmaFileDirectory;
  artifacts: ArtifactWriter;
  audit: AuditSink;
}

export class ExportService {
  constructor(private readonly deps: ExportServiceDeps) {}

  async ingest(command: IngestExportCommand, actor: string): Promise<ExportView> {
    const projectId = await this.resolveProject(command.page.fileKey);
    const idempotencyKey = idempotencyKeyFor(command);

    // Encode before writing anything: a malformed plate should fail the request,
    // not leave half the artifacts stored.
    const plateBytes = command.screenshots.map((shot) => ({
      ...shot,
      bytes: decodeBase64(shot.bytesBase64, shot.name),
    }));

    const ir = await this.deps.artifacts.store(projectId, {
      kind: "figma_ir",
      bytes: new TextEncoder().encode(JSON.stringify(command.ir)),
      meta: {
        fileName: command.page.fileName,
        pageName: command.page.pageName,
        rootNodeId: command.page.rootNodeId,
        jsonName: command.jsonName,
      },
      actor,
    });

    const plates: NewPlate[] = [];
    for (const [seq, shot] of plateBytes.entries()) {
      const stored = await this.deps.artifacts.store(projectId, {
        kind: "screenshot",
        bytes: shot.bytes,
        mediaType: "image/png",
        meta: { nodeId: shot.nodeId, name: shot.name },
        actor,
      });
      plates.push({ artifactId: stored.id, nodeId: shot.nodeId, name: shot.name, seq });
    }

    const health = healthOf(command.summary);

    const result = await this.deps.repo.create(
      {
        projectId,
        fileKey: command.page.fileKey,
        fileName: command.page.fileName,
        pageName: command.page.pageName,
        rootNodeId: command.page.rootNodeId,
        rootName: command.page.rootName,
        irArtifactId: ir.id,
        health,
        summary: command.summary,
        structuralSignature: command.structuralSignature ?? null,
        canonicalSignature: command.canonicalSignature ?? null,
        idempotencyKey,
        exportedAt: new Date(command.at),
        exportedBy: actor,
      },
      plates,
    );

    if (result.created) {
      await this.deps.audit.record({
        projectId,
        actor,
        action: "export.received",
        subjectType: "figma_export",
        subjectId: result.export.id,
        diff: {
          frame: command.page.rootName,
          rootNodeId: command.page.rootNodeId,
          coveragePercent: health.coveragePercent,
          plates: plates.length,
          irDigest: ir.digest,
        },
      });
    }

    return {
      ...toExportView(result.export, result.plates),
      deduplicated: !result.created,
    };
  }

  async list(projectId: string, query: ListExportsQuery): Promise<ExportView[]> {
    const rows = await this.deps.repo.list(projectId, query);
    return Promise.all(
      rows.map(async (row) => toExportView(row, await this.deps.repo.platesFor(row.id))),
    );
  }

  async get(projectId: string, id: string): Promise<ExportView> {
    const row = await this.deps.repo.findById(projectId, id);
    if (!row) throw AppError.notFound("export", id);
    return toExportView(row, await this.deps.repo.platesFor(row.id));
  }

  /**
   * Mark an export promoted (or dismissed).
   *
   * Kept separate from ingest on purpose. Receiving a frame is cheap and
   * automatic; deciding it is worth pipeline work is a human act, and the two
   * should not be the same write.
   */
  async setStatus(
    projectId: string,
    id: string,
    status: ExportStatus,
    actor: string,
    promotedRunId: string | null = null,
  ): Promise<ExportView> {
    const row = await this.deps.repo.setStatus(projectId, id, status, promotedRunId);
    if (!row) throw AppError.notFound("export", id);

    await this.deps.audit.record({
      projectId,
      actor,
      action: `export.${status}`,
      subjectType: "figma_export",
      subjectId: row.id,
      diff: { frame: row.rootName, promotedRunId },
    });

    return toExportView(row, await this.deps.repo.platesFor(row.id));
  }

  /**
   * An export for an unmapped Figma file is refused, never stored.
   *
   * Storing it under a guessed tenant would be worse than rejecting it: the
   * designer would see a success and the frame would be invisible in the
   * project that actually wanted it.
   */
  private async resolveProject(fileKey: string | null): Promise<string> {
    if (!fileKey) {
      throw AppError.unprocessable(
        "this Figma file has no file key — save the file in Figma, then export again",
      );
    }

    const projectId = await this.deps.files.projectIdForFile(fileKey);
    if (!projectId) {
      throw AppError.unprocessable(`Figma file ${fileKey} is not mapped to a project`, {
        fileKey,
        fix: "POST /v1/projects/:project/figma-files to claim it",
      });
    }
    return projectId;
  }
}

function decodeBase64(value: string, name: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw AppError.badRequest(`screenshot "${name}" is not valid base64`);
  }
}
