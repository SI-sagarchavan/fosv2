/**
 * The board's rows, as they arrive from Postgres.
 *
 * These are database column names, not a hand-built DTO — the board reads the
 * `figma_exports` and `figma_export_plates` tables through Electric, so the
 * shape is the table's. Numeric columns arrive as strings over the wire.
 */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface ExportRow {
  [key: string]: Json;
  id: string;
  file_name: string;
  page_name: string;
  root_node_id: string | null;
  root_name: string | null;
  node_count: string | number;
  bound_count: string | number;
  loose_count: string | number;
  coverage_percent: string | number;
  schema_valid: boolean;
  status: "received" | "promoted" | "dismissed";
  structural_signature: string | null;
  exported_at: string;
  received_at: string;
  exported_by: string | null;
}

export interface PlateRow {
  [key: string]: Json;
  id: string;
  export_id: string;
  artifact_id: string;
  node_id: string;
  name: string;
  seq: string | number;
}
