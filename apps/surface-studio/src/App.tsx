import { useEffect, useRef, useState } from "react";
import { useShape } from "@electric-sql/react";
import type { ExportRow, PlateRow, RunRow, RunStepRow } from "./types.js";

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

      <Compile row={row} />
    </article>
  );
}

/**
 * IR -> DSL, and the step trace while it happens.
 *
 * The run id is read from `promoted_run_id` on the synced row rather than held
 * in state, so a reload — or a second tab — shows the same trace instead of
 * offering to compile something that is already compiled.
 */
function Compile({ row }: { row: ExportRow }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runId = row.promoted_run_id;

  async function start(force = false): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/v1/compile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          exportId: row.id,
          irArtifact: row.ir_artifact_id,
          surfaceKey: surfaceKeyFor(row),
          surfaceName: titleOf(row),
          force,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? `${response.status} ${response.statusText}`);
      }
      // On success nothing is set here: the run id arrives over sync when the
      // control plane writes `promoted_run_id` back onto this row.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  if (runId) {
    return (
      <RunTrace
        runId={runId}
        onRecompile={() => void start(true)}
        recompiling={pending}
        error={error}
      />
    );
  }

  return (
    <div className="compile">
      <button className="go" onClick={() => void start()} disabled={pending}>
        {pending ? "Starting…" : "Compile to DSL"}
      </button>
      <span className="compile-note">
        load-inputs → compile → version → conform
      </span>
      {error ? <p className="compile-error">{error}</p> : null}
    </div>
  );
}

/** Live step trace, straight from `runs` / `run_steps` over the same sync. */
function RunTrace({
  runId,
  onRecompile,
  recompiling,
  error,
}: {
  runId: string;
  onRecompile: () => void;
  recompiling: boolean;
  error: string | null;
}) {
  const runs = useShape<RunRow>({ url: SYNC_URL, params: { table: "runs", run: runId } });
  const steps = useShape<RunStepRow>({
    url: SYNC_URL,
    params: { table: "run_steps", run: runId },
  });

  const run = (runs.data ?? [])[0];
  const ordered = [...(steps.data ?? [])].sort((a, b) => Number(a.seq) - Number(b.seq));

  return (
    <div className="compile">
      <p className="run-head">
        <span className={`run-status is-${run?.status ?? "queued"}`}>
          {run?.status ?? "queued"}
        </span>
        <span className="run-id">{runId.slice(0, 8)}</span>
        <button className="chip recompile" onClick={onRecompile} disabled={recompiling}>
          {recompiling ? "starting…" : "recompile"}
        </button>
      </p>

      {error ? <p className="compile-error">{error}</p> : null}

      <ol className="steps">
        {ordered.map((step) => (
          <li key={step.id}>
            <span className={`step-dot is-${step.status}`} />
            <span className="step-name">{step.name}</span>
            <span className="step-detail">{detailOf(step)}</span>
          </li>
        ))}
      </ol>

      {run?.error ? <p className="compile-error">{JSON.stringify(run.error)}</p> : null}

      {run?.status === "succeeded" ? <Preview runId={runId} /> : null}
    </div>
  );
}

/** The widths worth checking. Type tokens are per-breakpoint, so these differ. */
const WIDTHS = [
  { label: "Mobile", px: 390 },
  { label: "Tablet", px: 768 },
  { label: "Desktop", px: 1280 },
] as const;

/**
 * The compiled tree, rendered as a page.
 *
 * In an iframe, and scaled rather than reflowed. Both matter:
 *
 *   - the renderer's stylesheet is global (`:root` theme variables, font faces,
 *     `[data-fos-root]`), so in this document it would restyle the board;
 *   - the emitted CSS keys its media queries off the VIEWPORT. Fitting the page
 *     by shrinking the iframe would silently resolve mobile type for a desktop
 *     design. So the iframe keeps its true width and a CSS transform does the
 *     fitting — what you see is the real breakpoint, just smaller.
 */
function Preview({ runId }: { runId: string }) {
  const [width, setWidth] = useState<number>(1280);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState(600);
  const box = useRef<HTMLDivElement>(null);

  // Same-origin, so the content height is directly readable — no postMessage
  // handshake for something the DOM already knows.
  function onLoad(event: React.SyntheticEvent<HTMLIFrameElement>): void {
    const doc = event.currentTarget.contentDocument;
    if (doc?.body) setHeight(doc.body.scrollHeight || 600);
  }

  useEffect(() => {
    const node = box.current;
    if (!node) return;

    const fit = () => setScale(Math.min(1, node.clientWidth / width));
    fit();

    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [width]);

  return (
    <div className="preview">
      <div className="preview-bar">
        {WIDTHS.map((w) => (
          <button
            key={w.px}
            className={w.px === width ? "chip is-on" : "chip"}
            onClick={() => setWidth(w.px)}
          >
            {w.label}
          </button>
        ))}
        <span className="preview-note">
          {width}px · {Math.round(scale * 100)}%
        </span>
        <a className="preview-open" href={`/v1/preview/${runId}?width=${width}`} target="_blank" rel="noreferrer">
          open ↗
        </a>
      </div>

      <div className="preview-box" ref={box} style={{ height: height * scale }}>
        <iframe
          title="surface preview"
          src={`/v1/preview/${runId}?width=${width}`}
          onLoad={onLoad}
          style={{
            width,
            height,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        />
      </div>
    </div>
  );
}

/**
 * One line per step. The two that carry numbers worth reading are compile
 * (what the tree came out as) and conform (whether the gate passed) — the rest
 * say nothing a status dot has not already said.
 */
function detailOf(step: RunStepRow): string {
  const detail = step.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return "";
  const fields = detail as Record<string, Json>;

  if (step.name === "compile") {
    const notes = Array.isArray(fields.notes) ? fields.notes.length : 0;
    return notes > 0 ? `${notes} note${notes === 1 ? "" : "s"}` : "";
  }

  if (step.name === "conform") {
    const errors = Number(fields.errors ?? 0);
    const warnings = Number(fields.warnings ?? 0);
    return `${fields.ok === true ? "gate passed" : "gate failed"} · ${errors}E ${warnings}W`;
  }

  if (step.name === "load-inputs") {
    const nodes = Number(fields.irNodeCount ?? 0);
    return nodes > 0 ? `${nodes.toLocaleString()} nodes` : "";
  }

  if (step.name === "version") {
    return fields.version !== undefined ? `v${String(fields.version)}` : "";
  }

  return "";
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * A surface key the control plane will accept: lowercase kebab-case.
 *
 * Derived from the frame name, falling back to the node id, because a frame
 * called "Frame 1984079114" and one called "Match Card" should both produce a
 * key without the designer being asked to invent one.
 */
function surfaceKeyFor(row: ExportRow): string {
  const slug = slugify(row.root_name ?? "");
  if (slug.length >= 2) return slug;

  const fromNode = slugify(row.root_node_id ?? "");
  return fromNode.length >= 2 ? fromNode : `export-${row.id.slice(0, 8)}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
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
