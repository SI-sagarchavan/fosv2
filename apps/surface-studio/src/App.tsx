import { useEffect, useState } from "react";
import type { BoardExport } from "./types.js";

const POLL_MS = 2000;

export function App() {
  const rows = useExports();
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

      {latest ? <Plate row={latest} /> : <Empty />}

      {rows.length > 1 ? (
        <ol className="log">
          {rows.slice(1).map((row) => (
            <li key={row.id}>
              <span className="log-name">{titleOf(row)}</span>
              <span className="log-meta">
                {num(row.summary, "coveragePercent")}% · {when(row.receivedAt)}
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

function Plate({ row }: { row: BoardExport }) {
  const layers = num(row.summary, "nodeCount");
  const bound = num(row.summary, "coveragePercent");
  const shots = row.screenshots;

  return (
    <article className="plate">
      <header className="plate-head">
        <div>
          <h2>{titleOf(row)}</h2>
          <p className="plate-sub">
            {row.page.fileName} · {row.page.pageName}
          </p>
        </div>
        <p className="score">
          <span>{bound === null ? "—" : `${bound}%`}</span>
          <span className="score-label">bound</span>
        </p>
      </header>

      <p className="plate-stats">
        {layers === null ? "—" : layers.toLocaleString()} layers
        <span> · </span>
        {shots.length} {shots.length === 1 ? "plate" : "plates"}
        <span> · </span>
        {when(row.receivedAt)}
      </p>

      {shots.length > 0 ? (
        <div className="shots">
          {shots.map((shot) => (
            <figure key={shot.nodeId}>
              <img src={shot.src} alt={shot.name} />
              <figcaption>{shot.name.replace(/-\d+-\d+(?=\.png$)/, "")}</figcaption>
            </figure>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function useExports(): BoardExport[] {
  const [rows, setRows] = useState<BoardExport[]>([]);

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const res = await fetch("/v1/exports");
        if (!res.ok) return;
        const data = (await res.json()) as { exports?: BoardExport[] };
        if (!cancelled) setRows(data.exports ?? []);
      } catch {
        /* board is the server — a miss is a blink, not a toast */
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return rows;
}

function titleOf(row: BoardExport): string {
  return row.page.rootName || row.jsonName.replace(/\.ir\.json$/, "");
}

function num(summary: Record<string, unknown>, key: string): number | null {
  const value = summary[key];
  return typeof value === "number" ? value : null;
}

function when(at: number): string {
  const delta = Date.now() - at;
  if (delta < 10_000) return "just now";
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
