import { useMemo, useState } from "react";
import { setExportStatus } from "../api.js";
import { stageOf, useBoard, type Stage } from "../board.js";
import { haystack, pct, titleOf, when } from "../format.js";
import { go, href } from "../router.js";
import type { ExportRow, PlateRow } from "../types.js";

type Filter = "all" | Stage;
type Sort = "newest" | "oldest" | "coverage" | "layers" | "name";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "new", label: "Awaiting compile" },
  { id: "compiled", label: "Compiled" },
  { id: "dismissed", label: "Dismissed" },
];

const SORTS: Array<{ id: Sort; label: string }> = [
  { id: "newest", label: "Newest" },
  { id: "oldest", label: "Oldest" },
  { id: "coverage", label: "Lowest coverage" },
  { id: "layers", label: "Most layers" },
  { id: "name", label: "Name" },
];

function useStored<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [value, set] = useState<T>(() => {
    try {
      return (window.localStorage.getItem(key) as T | null) ?? initial;
    } catch {
      return initial;
    }
  });
  return [
    value,
    (v) => {
      set(v);
      try {
        window.localStorage.setItem(key, v);
      } catch {
        /* storage blocked — the choice just does not persist */
      }
    },
  ];
}

export function Board() {
  const { rows, loading, error, platesFor } = useBoard();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useStored<Filter>("studio.filter", "all");
  const [sort, setSort] = useStored<Sort>("studio.sort", "newest");
  const [file, setFile] = useStored<string>("studio.file", "");
  const [view, setView] = useStored<"grid" | "list">("studio.view", "grid");

  const files = useMemo(() => [...new Set(rows.map((r) => r.file_name))].sort(), [rows]);

  const counts = useMemo(() => {
    const c = { all: rows.length, new: 0, compiled: 0, dismissed: 0 };
    for (const r of rows) c[stageOf(r)] += 1;
    return c;
  }, [rows]);

  const live = rows.filter((r) => r.status !== "dismissed");
  const avg = live.length ? live.reduce((a, r) => a + Number(r.coverage_percent), 0) / live.length : 0;
  const layers = live.reduce((a, r) => a + Number(r.node_count), 0);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter(
      (r) =>
        (filter === "all" || stageOf(r) === filter) &&
        (!file || r.file_name === file) &&
        (!q || haystack(r).includes(q)),
    );
    const by: Record<Sort, (a: ExportRow, b: ExportRow) => number> = {
      newest: (a, b) => Date.parse(b.received_at) - Date.parse(a.received_at),
      oldest: (a, b) => Date.parse(a.received_at) - Date.parse(b.received_at),
      coverage: (a, b) => Number(a.coverage_percent) - Number(b.coverage_percent),
      layers: (a, b) => Number(b.node_count) - Number(a.node_count),
      name: (a, b) => titleOf(a).localeCompare(titleOf(b)),
    };
    return list.sort(by[sort]);
  }, [rows, filter, file, query, sort]);

  if (error) return <SyncError message={error} />;
  if (!loading && rows.length === 0) return <Empty />;

  return (
    <div className="board">
      <section className="stats" aria-label="Board summary">
        <Stat label="On the board" value={String(live.length)} note={counts.dismissed ? `${counts.dismissed} dismissed` : undefined} />
        <Stat label="Compiled" value={String(counts.compiled)} note={counts.new ? `${counts.new} waiting` : "none waiting"} />
        <Stat label="Mean binding coverage" value={`${pct(avg)}%`} />
        <Stat label="Layers" value={layers.toLocaleString()} />
      </section>

      <div className="toolbar">
        <input
          className="search"
          type="search"
          placeholder="Search frame, file, page, author…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search exports"
        />
        <div className="seg" role="tablist" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              className={filter === f.id ? "seg-btn is-on" : "seg-btn"}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              <span className="seg-count">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <select className="select" value={file} onChange={(e) => setFile(e.target.value)} aria-label="Filter by file">
          <option value="">All files</option>
          {files.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <select className="select" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <div className="seg" role="group" aria-label="Layout">
          <button className={view === "grid" ? "seg-btn is-on" : "seg-btn"} onClick={() => setView("grid")}>
            Grid
          </button>
          <button className={view === "list" ? "seg-btn is-on" : "seg-btn"} onClick={() => setView("list")}>
            List
          </button>
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="none">
          Nothing matches.{" "}
          <button
            className="linkish"
            onClick={() => {
              setQuery("");
              setFilter("all");
              setFile("");
            }}
          >
            Clear filters
          </button>
        </p>
      ) : (
        <ul className={view === "grid" ? "cards" : "rowsview"}>
          {shown.map((row) => (
            <li key={row.id}>
              <Card row={row} plates={platesFor(row.id)} list={view === "list"} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string | undefined }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {note ? <span className="stat-note">{note}</span> : null}
    </div>
  );
}

function SyncError({ message }: { message: string }) {
  return (
    <section className="empty">
      <p className="empty-title">The board cannot read exports</p>
      <p className="compile-error">{message}</p>
      <p>
        The <a href={href("/playground")}>Playground</a> and <a href={href("/pipeline")}>Pipeline</a> pages do not need the
        control plane.
      </p>
    </section>
  );
}

function Empty() {
  return (
    <section className="empty">
      <p className="empty-title">Nothing on the board</p>
      <p>
        In <em>FanOS Surface Canvas</em>, open Export and press <em>Send to Surface Studio</em>. The ZIP is only
        for when this desk is down.
      </p>
      <p>
        Want to see the pipeline without Figma? Drop an IR file into the <a href={href("/playground")}>Playground</a>.
      </p>
    </section>
  );
}

function Card({ row, plates, list }: { row: ExportRow; plates: PlateRow[]; list: boolean }) {
  const stage = stageOf(row);
  const cov = pct(row.coverage_percent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const thumb = plates[0];

  async function toggle(e: React.MouseEvent): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    setError(null);
    try {
      await setExportStatus(row.id, stage === "dismissed" ? "received" : "dismissed");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`card is-${stage}${list ? " is-list" : ""}`}>
      <a className="card-link" href={href(`/export/${row.id}`)} aria-label={`Open ${titleOf(row)}`} />
      <div className="card-shot">
        {thumb ? <img src={`/v1/blobs/${thumb.artifact_id}`} alt="" loading="lazy" /> : <span className="card-noshot">no plate</span>}
        <span className={`badge is-${stage}`}>{stage === "new" ? "awaiting compile" : stage}</span>
      </div>
      <div className="card-body">
        <h3 className="card-title">{titleOf(row)}</h3>
        <p className="card-sub">
          {row.file_name} · {row.page_name}
        </p>
        <div className="meter" title={`${cov}% of paint is bound to a token`}>
          <span className="meter-fill" style={{ width: `${Math.min(100, cov)}%` }} data-low={cov < 60 ? "" : undefined} />
        </div>
        <p className="card-meta">
          <span>{cov}% bound</span>
          <span>{Number(row.node_count).toLocaleString()} layers</span>
          <span>{when(row.received_at)}</span>
        </p>
        {error ? <p className="compile-error">{error}</p> : null}
      </div>
      <div className="card-actions">
        <button className="chip" onClick={() => go(`/export/${row.id}/gaps`)}>
          Gaps
        </button>
        <button className="chip" onClick={() => go(`/export/${row.id}/ir`)}>
          IR
        </button>
        <button className="chip" onClick={() => go(`/export/${row.id}/dsl`)}>
          DSL
        </button>
        <button className="chip chip-quiet" onClick={(e) => void toggle(e)} disabled={busy}>
          {stage === "dismissed" ? "Restore" : "Dismiss"}
        </button>
      </div>
    </article>
  );
}
