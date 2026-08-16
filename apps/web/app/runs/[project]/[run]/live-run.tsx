"use client";

/**
 * Live run progress, synced from Postgres.
 *
 * The property worth understanding: this component holds no progress state of
 * its own and never asks "what did I miss". The work runs in the BullMQ worker
 * and every transition is written to `runs` / `run_steps`, so the database is
 * the progress. Electric streams that table subset here.
 *
 * Closing the tab therefore changes nothing. The worker keeps going, the rows
 * keep updating, and a new mount subscribes from offset -1 — which returns the
 * current state immediately, then goes live. Same behaviour as reopening a
 * ChatGPT tab mid-answer, for the same reason: the server never depended on
 * the client being there.
 *
 * Every request goes to apps/api, never to Electric directly — Electric has no
 * notion of API keys or tenants.
 */
import { useShape } from "@electric-sql/react";

/**
 * `useShape` requires rows to be `Record<string, Value>`, so the jsonb columns
 * are typed as JSON rather than `unknown` and each row carries an index
 * signature. Numeric columns arrive as strings over the wire — Electric does
 * not narrow int4 vs int8 for the client — hence `string | number`.
 */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

/** Mirrors `runs` / `run_steps`, but only the columns this view reads. */
interface RunRow {
  [key: string]: Json;
  id: string;
  status: RunStatus;
  kind: string;
  attempt: string | number;
  max_attempts: string | number;
  error: Json;
  queued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

interface StepRow {
  [key: string]: Json;
  seq: string | number;
  name: string;
  status: StepStatus;
  detail: Json;
  error: Json;
  started_at: string | null;
  finished_at: string | null;
}

const STATUS_COLOUR: Record<string, string> = {
  queued: "#7f7f7f",
  pending: "#7f7f7f",
  running: "#7dd3fc",
  succeeded: "#4ade80",
  failed: "#e10a15",
  cancelled: "#f59e0b",
  skipped: "#4b5563",
};

export function LiveRun({ apiUrl, project, run }: { apiUrl: string; project: string; run: string }) {
  const url = `${apiUrl}/v1/projects/${project}/sync`;

  const runs = useShape<RunRow>({ url, params: { table: "runs", run } });
  const steps = useShape<StepRow>({ url, params: { table: "run_steps", run } });

  const current = runs.data?.[0];
  const ordered = [...(steps.data ?? [])].sort((a, b) => Number(a.seq) - Number(b.seq));

  if (runs.isLoading && !current) return <Chrome>connecting…</Chrome>;
  if (!current) return <Chrome>no such run</Chrome>;

  const settled = ["succeeded", "failed", "cancelled"].includes(current.status);

  return (
    <Chrome>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
        <Dot status={current.status} />
        <strong style={{ fontSize: 15 }}>{current.kind}</strong>
        <span style={{ color: STATUS_COLOUR[current.status], fontSize: 13 }}>
          {current.status}
        </span>
        {Number(current.attempt) > 1 && (
          <span style={{ color: "#f59e0b", fontSize: 12 }}>
            attempt {String(current.attempt)}/{String(current.max_attempts)}
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.55 }}>
          {settled ? "settled" : "live — safe to close this tab"}
        </span>
      </div>

      <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {ordered.map((step) => (
          <li
            key={String(step.seq)}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "9px 0",
              borderTop: "1px solid #1f1f1f",
              opacity: step.status === "pending" || step.status === "skipped" ? 0.45 : 1,
            }}
          >
            <Dot status={step.status} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span>{step.name}</span>
                <span style={{ fontSize: 11, color: STATUS_COLOUR[step.status] }}>
                  {step.status}
                </span>
                <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.5 }}>
                  {duration(step.started_at, step.finished_at)}
                </span>
              </div>
              {summarise(step.detail) && (
                <div
                  style={{
                    fontSize: 11,
                    opacity: 0.6,
                    marginTop: 3,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {summarise(step.detail)}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>

      {current.error != null && (
        <pre
          style={{
            marginTop: 16,
            padding: 12,
            background: "#1a0a0b",
            color: "#ff9aa0",
            fontSize: 11,
            borderRadius: 6,
            whiteSpace: "pre-wrap",
          }}
        >
          {JSON.stringify(current.error, null, 2)}
        </pre>
      )}
    </Chrome>
  );
}

function Dot({ status }: { status: string }) {
  const colour = STATUS_COLOUR[status] ?? "#7f7f7f";
  return (
    <span
      aria-hidden
      style={{
        width: 9,
        height: 9,
        borderRadius: "50%",
        marginTop: 5,
        flexShrink: 0,
        background: colour,
        // The only motion on the page, and it means one thing: work in flight.
        animation: status === "running" ? "fos-pulse 1.1s ease-in-out infinite" : undefined,
      }}
    />
  );
}

function Chrome({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "ui-monospace, monospace",
        fontSize: 13,
        color: "#ddd",
        background: "#0b0b0b",
        padding: 24,
        borderRadius: 10,
        maxWidth: 720,
      }}
    >
      <style>{"@keyframes fos-pulse{0%,100%{opacity:1}50%{opacity:.25}}"}</style>
      {children}
    </div>
  );
}

function duration(from: string | null, to: string | null): string {
  if (!from) return "";
  const end = to ? Date.parse(to) : Date.now();
  const ms = end - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** One line of whatever the step chose to record. */
function summarise(detail: Json): string {
  if (detail === null || typeof detail !== "object") return "";
  const d = detail as Record<string, unknown>;

  if (typeof d.irNodeCount === "number") return `${d.irNodeCount} IR nodes`;
  if (d.stats && typeof d.stats === "object") {
    const s = d.stats as Record<string, unknown>;
    return `${s.emitted} nodes emitted, ${s.absorbed} absorbed`;
  }
  if (typeof d.version === "number") return `version ${d.version}`;
  if (typeof d.ok === "boolean") {
    return `gate ${d.ok ? "passed" : "failed"} — ${d.errors} errors, ${d.warnings} warnings`;
  }
  return "";
}
