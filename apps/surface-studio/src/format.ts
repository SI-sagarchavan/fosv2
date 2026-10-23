import type { ExportRow } from "./types.js";

export function titleOf(row: ExportRow): string {
  return row.root_name || row.root_node_id || "untitled frame";
}

/** Coverage arrives as a string over the wire; one decimal is what Health shows. */
export function pct(value: string | number): number {
  return Math.round(Number(value) * 10) / 10;
}

export function when(iso: string): string {
  const delta = Date.now() - Date.parse(iso);
  if (delta < 10_000) return "just now";
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
}

/**
 * A surface key the control plane will accept: lowercase kebab-case.
 *
 * Derived from the frame name, falling back to the node id, because a frame
 * called "Frame 1984079114" and one called "Match Card" should both produce a
 * key without the designer being asked to invent one.
 */
export function surfaceKeyFor(row: ExportRow): string {
  const slug = slugify(row.root_name ?? "");
  if (slug.length >= 2) return slug;

  const fromNode = slugify(row.root_node_id ?? "");
  return fromNode.length >= 2 ? fromNode : `export-${row.id.slice(0, 8)}`;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

/** Plain text for a search box: every field a person might type from memory. */
export function haystack(row: ExportRow): string {
  return [titleOf(row), row.file_name, row.page_name, row.exported_by ?? "", row.root_node_id ?? ""]
    .join(" ")
    .toLowerCase();
}

export function download(name: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
