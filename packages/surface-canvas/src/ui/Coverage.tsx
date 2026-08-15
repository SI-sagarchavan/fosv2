/**
 * The score, on its own surface.
 *
 * Coverage is a proportion and the bar is the shape of one, read left to right
 * the way a fill gauge is: how much of this frame is described by tokens, and
 * how much is still hand-typed. The dashed length carrying on past the solid one
 * is what the footer's Bind button would add, so the promise and the picture are
 * the same number by construction.
 *
 * The block sits one step off the page background because it is the only thing
 * here that is a reading rather than a task. Everything below it is work.
 *
 * Session, not since-last-report: a delta that resets every time you look away
 * cannot answer "am I getting anywhere".
 */
import type { JSX } from "react";
import type { StudioState } from "./state.js";

export function Coverage({ state }: { state: StudioState }): JSX.Element {
  const report = state.report;
  const coverage = report?.coverage;

  if (!coverage) {
    return (
      <div className="cov">
        <span className="muted">{state.status || "Reading the page…"}</span>
      </div>
    );
  }

  if (coverage.total === 0) {
    return (
      <div className="cov">
        <div className="truncate" style={{ fontWeight: 600 }}>
          Nothing bindable in {report?.rootName ?? "this frame"}
        </div>
        <div className="muted">Select the page frame and use “Check … instead”.</div>
      </div>
    );
  }

  const session =
    state.sessionBasePercent === null
      ? 0
      : Math.round((coverage.percent - state.sessionBasePercent) * 10) / 10;

  return (
    <div className="cov">
      <div className="cov-top">
        <span className="cov-score">{coverage.percent}%</span>
        <span className="cov-of">bound</span>
        <span className="grow" />
        <span
          className="truncate cov-frame"
          title={`${report?.pageName ?? ""} · ${state.nodeCount} layers`}
        >
          {report?.rootName || state.pageName || "—"}
        </span>
      </div>

      <div
        className="meter"
        title={
          `${coverage.bound.toLocaleString()} of ${coverage.total.toLocaleString()} slots bound` +
          (coverage.oneClickAway > 0
            ? ` · ${coverage.oneClickAway.toLocaleString()} more are one click away`
            : "")
        }
      >
        <div className="meter-bound" style={{ width: `${coverage.percent}%` }} />
        <div className="meter-ready" style={{ width: `${coverage.oneClickPercent}%` }} />
      </div>

      <div className="stats">
        <Stat value={coverage.bound.toLocaleString()} label="bound" />
        <Stat
          value={coverage.loose.toLocaleString()}
          label="loose"
          tone={coverage.loose > 0 ? "warn" : undefined}
        />
        <Stat
          value={session === 0 ? "—" : `${session > 0 ? "+" : "−"}${Math.abs(session)}`}
          label="session"
          tone={session > 0 ? "gain" : session < 0 ? "warn" : undefined}
          title={
            state.sessionBasePercent === null
              ? undefined
              : `Started this session at ${state.sessionBasePercent}%`
          }
        />
        {coverage.oneClickAway > 0 ? (
          <>
            <span className="grow" />
            <Stat
              value={`+${coverage.oneClickPercent}`}
              label="ready"
              tone="gain"
              align="right"
              title={`${coverage.oneClickAway.toLocaleString()} layers are an exact match — the dashed length on the bar`}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

function Stat({
  value,
  label,
  tone,
  title,
  align,
}: {
  value: string;
  label: string;
  tone?: "gain" | "warn";
  title?: string;
  align?: "right";
}): JSX.Element {
  return (
    <div className="stat" title={title} style={align ? { textAlign: align } : undefined}>
      <div className={tone ? `stat-value ${tone}` : "stat-value"}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
