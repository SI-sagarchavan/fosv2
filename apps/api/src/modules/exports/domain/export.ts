/**
 * Figma exports: the event a designer creates by pressing Send.
 *
 * The IR and the plates are artifacts; this is the record of the act. Every
 * rule about what a valid export is, and how two sends of the same frame relate
 * to each other, lives here as a pure function.
 */
import { z } from "zod";

/** Health numbers the plugin reports, promoted out of the summary blob. */
export interface ExportHealth {
  nodeCount: number;
  boundCount: number;
  looseCount: number;
  coveragePercent: number;
  schemaValid: boolean;
}

export interface FigmaExport {
  id: string;
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
  status: ExportStatus;
  promotedRunId: string | null;
  surfaceId: string | null;
  idempotencyKey: string;
  exportedAt: Date;
  receivedAt: Date;
  exportedBy: string | null;
}

export type ExportStatus = "received" | "promoted" | "dismissed";

export interface ExportPlate {
  id: string;
  exportId: string;
  artifactId: string;
  nodeId: string;
  name: string;
  seq: number;
}

// ---------------------------------------------------------------------------
// the ingest command
// ---------------------------------------------------------------------------

const PLATE_LIMIT = 64;

/**
 * What the plugin posts, via Surface Studio.
 *
 * `ir` stays `unknown` on purpose: this module does not parse Frame IR. It
 * stores the bytes and records the act. The compiler validates the schema when
 * a run reads the artifact, which is the only place that can act on the answer.
 */
export const IngestExportCommand = z.object({
  page: z.object({
    fileKey: z.string().nullable(),
    fileName: z.string().min(1),
    pageName: z.string().min(1),
    rootNodeId: z.string().nullable(),
    rootName: z.string().nullable(),
  }),
  /** Figma-side epoch millis. */
  at: z.number().int().positive(),
  jsonName: z.string().min(1),
  ir: z.unknown(),
  summary: z.record(z.unknown()).default({}),
  screenshots: z
    .array(
      z.object({
        name: z.string().min(1),
        nodeId: z.string().min(1),
        bytesBase64: z.string(),
      }),
    )
    .max(PLATE_LIMIT)
    .default([]),
  /**
   * Static background images the designer marked in Surface Canvas.
   * Separate from screenshots: those are section plates, these are files
   * the compiler turns into `asset.texture.*`.
   */
  assets: z
    .array(
      z.object({
        name: z.string().min(1),
        nodeId: z.string().min(1),
        targetNodeId: z.string().min(1),
        role: z.literal("background"),
        /**
         * `original` — the bytes out of Figma's image store. `rendered` — the
         * node re-exported as a PNG, which is always the case for a composite
         * of several layers because flattening IS a render.
         *
         * Optional so an older plugin build still posts. Recorded on the
         * artifact rather than dropped: a render bakes in opacity, effects and
         * the on-canvas scale, and that is worth knowing about a file that
         * ships.
         */
        source: z.enum(["original", "rendered"]).optional(),
        bytesBase64: z.string(),
      }),
    )
    .max(PLATE_LIMIT)
    .default([]),
  /** Signatures, when the plugin computed them. */
  structuralSignature: z.string().optional(),
  canonicalSignature: z.string().optional(),
});
export type IngestExportCommand = z.infer<typeof IngestExportCommand>;

export const ListExportsQuery = z.object({
  status: z.enum(["received", "promoted", "dismissed"]).optional(),
  rootNodeId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListExportsQuery = z.infer<typeof ListExportsQuery>;

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

/**
 * The natural key for one send.
 *
 * A frame cannot be exported twice in the same millisecond, so the frame plus
 * its Figma-side clock identifies the act. Deliberately NOT the IR digest:
 * exporting the same unchanged frame tomorrow is a real second event, and
 * collapsing those would destroy the history the board exists to show.
 */
export function idempotencyKeyFor(command: IngestExportCommand): string {
  const { page, at } = command;
  return [page.fileKey ?? "local", page.rootNodeId ?? page.rootName ?? "root", at].join(":");
}

/**
 * Pull the health numbers the schema promotes to columns.
 *
 * Missing metrics become zeroes rather than rejecting the export. A plugin
 * version that stops reporting `looseCount` should not make frames unsendable;
 * the raw summary is stored alongside regardless, so nothing is lost.
 */
export function healthOf(summary: Record<string, unknown>): ExportHealth {
  return {
    nodeCount: intOf(summary.nodeCount),
    boundCount: intOf(summary.boundCount),
    looseCount: intOf(summary.looseCount),
    coveragePercent: numberOf(summary.coveragePercent),
    schemaValid: summary.schemaValid !== false,
  };
}

/**
 * Whether this send differs structurally from the one before it.
 *
 * The board uses this to keep a re-export after a cosmetic nudge from looking
 * like new work. Unknown signatures mean "assume changed" — silently claiming
 * two frames are identical is the worse failure.
 */
export function hasChangedFrom(
  previous: Pick<FigmaExport, "structuralSignature"> | null,
  next: { structuralSignature?: string | null },
): boolean {
  if (!previous?.structuralSignature || !next.structuralSignature) return true;
  return previous.structuralSignature !== next.structuralSignature;
}

/** Coverage is the ceiling on everything downstream — see the Health tab. */
export function isPublishableQuality(health: ExportHealth, floor = 100): boolean {
  return health.schemaValid && health.coveragePercent >= floor;
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

export interface ExportPlateView {
  nodeId: string;
  name: string;
  seq: number;
  artifactId: string;
}

export interface ExportAssetView {
  name: string;
  nodeId: string;
  targetNodeId: string;
  role: "background";
  artifactId: string;
}

export interface ExportView {
  id: string;
  fileKey: string | null;
  fileName: string;
  pageName: string;
  rootNodeId: string | null;
  rootName: string | null;
  irArtifactId: string;
  health: ExportHealth;
  summary: Record<string, unknown>;
  structuralSignature: string | null;
  status: ExportStatus;
  promotedRunId: string | null;
  exportedAt: string;
  receivedAt: string;
  exportedBy: string | null;
  plates: ExportPlateView[];
  assets: ExportAssetView[];
  /** True when these exact bytes and timestamp were already recorded. */
  deduplicated?: boolean;
}

export function assetsFromSummary(summary: Record<string, unknown>): ExportAssetView[] {
  const raw = summary.backgroundAssets;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (
      typeof row.name !== "string" ||
      typeof row.nodeId !== "string" ||
      typeof row.targetNodeId !== "string" ||
      typeof row.artifactId !== "string"
    ) {
      return [];
    }
    return [
      {
        name: row.name,
        nodeId: row.nodeId,
        targetNodeId: row.targetNodeId,
        role: "background" as const,
        artifactId: row.artifactId,
      },
    ];
  });
}

export function toExportView(row: FigmaExport, plates: ExportPlate[]): ExportView {
  return {
    id: row.id,
    fileKey: row.fileKey,
    fileName: row.fileName,
    pageName: row.pageName,
    rootNodeId: row.rootNodeId,
    rootName: row.rootName,
    irArtifactId: row.irArtifactId,
    health: row.health,
    summary: row.summary,
    structuralSignature: row.structuralSignature,
    status: row.status,
    promotedRunId: row.promotedRunId,
    exportedAt: row.exportedAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    exportedBy: row.exportedBy,
    plates: plates
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((p) => ({ nodeId: p.nodeId, name: p.name, seq: p.seq, artifactId: p.artifactId })),
    assets: assetsFromSummary(row.summary),
  };
}

function intOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
