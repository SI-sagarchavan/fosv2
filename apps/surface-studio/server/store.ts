/**
 * In-memory board. Newest first. A restart wipes it — this is the listening
 * desk for a session, not the corpus yet.
 */
import type { StudioExport } from "./schema.js";

export interface StoredExport extends StudioExport {
  id: string;
  receivedAt: number;
}

const KEEP = 20;
const rows: StoredExport[] = [];

export function remember(body: StudioExport): StoredExport {
  const row: StoredExport = {
    ...body,
    id: `${body.at.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    receivedAt: Date.now(),
  };
  rows.unshift(row);
  if (rows.length > KEEP) rows.length = KEEP;
  return row;
}

export function list(): StoredExport[] {
  return rows;
}

export function count(): number {
  return rows.length;
}
