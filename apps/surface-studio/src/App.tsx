import { useShape } from "@electric-sql/react";
import type { ExportRow, PlateRow } from "./types.js";

/**
 * The board reads Postgres. Surface Studio stores nothing.
 *
 * `useShape` subscribes through this origin, which adds the service credential
 * and forwards to the control plane. Reopening the tab resumes rather than
 * refetches, and an export that landed while the board was closed is simply
 * there — the same property the run view has, for the same reason.
 */
// Absolute: Electric's client resolves this with `new URL()`, which rejects a
// bare path. Same origin, so the browser still never sees the API key.
const SYNC_URL = `${window.location.origin}/v1/sync`;


export function App() {
  const { rows, platesFor } = useBoard();
  const latest = rows[0] ?? null;

  return (
    <div className="app">
      <header className="head">
        <div>
          <p className="eyebrow">FanOS</p>
          <h1>Surface Studio</h1>
        </div>
        <p className={rows.length > 0 ? "live is-on" : "live"}>
          {rows.length > 0 ? `${rows.length} on the board` : "listening :3000"}
        </p>
      </header>

      {latest ? <Plate row={latest} plates={platesFor(latest.id)} /> : <Empty />}

      {rows.length > 1 ? (
        <ol className="log">
          {rows.slice(1).map((row) => (
            <li key={row.id}>
              <span className="log-name">{titleOf(row)}</span>
              <span className="log-meta">
                {pct(row.coverage_percent)}% · {when(row.received_at)}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function Empty() {
  return (
    <section className="empty">
      <p className="empty-title">Nothing on the board</p>
      <p>
        In <em>FanOS Surface Canvas</em>, open Export and press <em>Send to Surface Studio</em>.
        The ZIP is only for when this desk is down.
      </p>
    </section>
  );
}

function Plate({ row, plates }: { row: ExportRow; plates: PlateRow[] }) {
  const layers = Number(row.node_count);
  const bound = pct(row.coverage_percent);

  return (
    <article className="plate">
      <header className="plate-head">
        <div>
          <h2>{titleOf(row)}</h2>
          <p className="plate-sub">
            {row.file_name} · {row.page_name}
          </p>
        </div>
        <p className="score">
          <span>{`${bound}%`}</span>
          <span className="score-label">bound</span>
        </p>
      </header>

      <p className="plate-stats">
        {layers.toLocaleString()} layers
        <span> · </span>
        {plates.length} {plates.length === 1 ? "plate" : "plates"}
        <span> · </span>
        {when(row.received_at)}
      </p>

      {plates.length > 0 ? (
        <div className="shots">
          {plates.map((plate) => (
            <figure key={plate.id}>
              {/* Immutable blob, fetched once and cached — not re-sent with
                  every board update the way inline base64 was. */}
              <img src={`/v1/blobs/${plate.artifact_id}`} alt={plate.name} />
              <figcaption>{plate.name.replace(/-\d+-\d+(?=\.png$)/, "")}</figcaption>
            </figure>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function useBoard(): { rows: ExportRow[]; platesFor: (id: string) => PlateRow[] } {
  const exports = useShape<ExportRow>({ url: SYNC_URL, params: { table: "figma_exports" } });
  const plates = useShape<PlateRow>({ url: SYNC_URL, params: { table: "figma_export_plates" } });

  const rows = [...(exports.data ?? [])].sort(
    (a, b) => Date.parse(b.received_at) - Date.parse(a.received_at),
  );

  const platesFor = (exportId: string) =>
    (plates.data ?? [])
      .filter((p) => p.export_id === exportId)
      .sort((a, b) => Number(a.seq) - Number(b.seq));

  return { rows, platesFor };
}

function titleOf(row: ExportRow): string {
  return row.root_name || row.root_node_id || "untitled frame";
}

/** Coverage arrives as a string over the wire; one decimal is what Health shows. */
function pct(value: string | number): number {
  return Math.round(Number(value) * 10) / 10;
}

function when(iso: string): string {
  const delta = Date.now() - Date.parse(iso);
  if (delta < 10_000) return "just now";
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
