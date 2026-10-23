import { useShape } from "@electric-sql/react";
import { SYNC_URL } from "./components/compile.js";
import type { ExportRow, PlateRow } from "./types.js";

/**
 * The board reads Postgres. Surface Studio stores nothing.
 *
 * `useShape` subscribes through this origin. Reopening the tab resumes rather
 * than refetches, and an export that landed while the board was closed is simply
 * there.
 */
export function useBoard(): {
  rows: ExportRow[];
  loading: boolean;
  /** Why the board cannot read Postgres, in words — null when it can. */
  error: string | null;
  platesFor: (id: string) => PlateRow[];
  byId: (id: string) => ExportRow | undefined;
} {
  const exports = useShape<ExportRow>({ url: SYNC_URL, params: { table: "figma_exports" } });
  const plates = useShape<PlateRow>({ url: SYNC_URL, params: { table: "figma_export_plates" } });

  const rows = [...(exports.data ?? [])].sort(
    (a, b) => Date.parse(b.received_at) - Date.parse(a.received_at),
  );

  const platesFor = (exportId: string) =>
    (plates.data ?? [])
      .filter((p) => p.export_id === exportId)
      .sort((a, b) => Number(a.seq) - Number(b.seq));

  const failure = exports.error ?? plates.error;

  return {
    rows,
    error: failure ? explainSync(failure) : null,
    loading: exports.isLoading && !failure,
    platesFor,
    byId: (id) => rows.find((r) => r.id === id),
  };
}

/** What the board calls an export, from the two columns that decide it. */
export type Stage = "new" | "compiled" | "dismissed";

export function stageOf(row: ExportRow): Stage {
  if (row.status === "dismissed") return "dismissed";
  return row.promoted_run_id ? "compiled" : "new";
}

/**
 * A sync failure arrives as an HTTP error with the control plane's JSON in the
 * message. The common one on a fresh database is a missing project, and that
 * has a one-line fix, so say it instead of leaving a board that looks empty.
 */
function explainSync(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const project = /project (\S+) not found/.exec(message);
  if (project) {
    return `The control plane has no project “${project[1]}”. Create it, and upload a token_set theme, before the board can read exports.`;
  }
  if (/50[234]|unreachable|fetch failed|Failed to fetch/i.test(message)) {
    return "Studio cannot reach the control plane. Check that the API is running (pnpm dev:api) and FANOS_API_URL points at it.";
  }
  return message;
}
