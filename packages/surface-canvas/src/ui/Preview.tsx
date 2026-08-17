/**
 * What this frame actually compiles to.
 *
 * The panel could always say a great deal about a frame — coverage, loose
 * values, which images were marked — and nothing at all about the only question
 * that decides whether any of it worked: *what does it look like?* Answering
 * that meant an export, a control-plane run, a compile, a fidelity gate and a
 * preview fetch, so every mistake was found several services away from the
 * person who could fix it. A header built from decorative vectors shipped as a
 * page of dashed placeholders that way.
 *
 * The pixels here come from the SAME compiler and the SAME renderer a real run
 * uses — Surface Studio runs both, because `@fanos/compile` imports the IR
 * package and a plugin that imported the compiler would close a dependency
 * cycle. That indirection is worth it: a preview produced by a second,
 * plugin-local approximation could disagree with the pipeline, and a preview
 * that can lie is worse than no preview.
 */
import type { JSX } from "react";
import type { PreviewSummary } from "../api/types.js";
import { send } from "./main.js";
import type { StudioState } from "./state.js";

/** Note kinds worth pulling out by name, and how to read them. */
const NOTE_LABELS: Record<string, string> = {
  "unknown-icon": "unresolved glyphs",
  "decorative-vector": "vectors emitted as plain boxes",
  "unresolved-text-style": "text with no style — dropped",
  "unresolved-paint": "paint bound to no token",
  "background-asset": "marked backgrounds",
  "pinned-size": "sizes pinned to px",
};

/** Kinds that mean something came out wrong, as opposed to merely happening. */
const PROBLEM_KINDS = new Set([
  "unknown-icon",
  "decorative-vector",
  "unresolved-text-style",
  "unresolved-paint",
]);

export function PreviewPanel({ state }: { state: StudioState }): JSX.Element {
  const running = state.previewProgress !== "";

  return (
    <div className="section">
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="grow" style={{ fontWeight: 600 }}>
          Compiled preview
        </span>
        <button
          className={state.previewHtml ? "outline" : "primary"}
          disabled={state.busy}
          onClick={() => send({ type: "preview-compile" })}
          title="Compile this frame and render it, exactly as a run would"
        >
          {running ? state.previewProgress : state.previewHtml ? "Refresh" : "Compile & preview"}
        </button>
      </div>

      {state.previewError ? (
        <div style={{ color: "var(--fos-danger)" }}>{state.previewError}</div>
      ) : null}

      {state.previewHtml ? (
        <PreviewFrame html={state.previewHtml} width={state.previewWidth || 1366} />
      ) : !state.previewError && !running ? (
        <div className="muted">
          Compiles this frame through the real pipeline and renders it. Needs Surface
          Studio running.
        </div>
      ) : null}

      {state.previewSummary ? <Summary summary={state.previewSummary} /> : null}
    </div>
  );
}

/**
 * The page at its real width, scaled to fit the panel.
 *
 * NOT reflowed. A 1366px design squeezed into a 420px iframe answers a question
 * nobody asked — how the tree behaves at panel width — while hiding the one
 * that was asked. Transform-scaling keeps every proportion, and the wrapper is
 * given the scaled height so it occupies the right amount of room.
 */
function PreviewFrame({ html, width }: { html: string; width: number }): JSX.Element {
  // The panel is 448px wide with 14px padding each side.
  const available = 420;
  const scale = Math.min(1, available / width);
  // Tall pages are clipped rather than shown whole: the top of a page is what
  // identifies it, and a 4:1 letterbox is easier to read than a full-page strip.
  const height = Math.round(Math.min(width * 0.75, 900) * scale);

  return (
    <div className="preview-frame-wrap" style={{ height }}>
      {/*
        `srcdoc`, not a URL. The plugin's manifest allowlists the board for
        fetch; pointing an iframe at it is a different permission and would
        need a manifest change every designer has to re-accept. The document is
        already in hand, so there is nothing to fetch.

        Sandboxed with no `allow-scripts`: this is generated markup rendered
        inside a plugin, and it only has to be looked at.
      */}
      <iframe
        className="preview-frame"
        title="Compiled preview"
        sandbox=""
        srcDoc={html}
        style={{
          width: `${width}px`,
          height: `${Math.round(height / scale)}px`,
          transform: `scale(${scale})`,
        }}
      />
    </div>
  );
}

function Summary({ summary }: { summary: PreviewSummary }): JSX.Element {
  const problems = Object.entries(summary.notes)
    .filter(([kind]) => PROBLEM_KINDS.has(kind))
    .sort((a, b) => b[1] - a[1]);

  return (
    <div style={{ marginTop: 8 }}>
      <div className="truncate">
        <strong>{summary.nodes}</strong> nodes
        <span className="muted">
          {" "}
          from {summary.irNodes} layers · {summary.absorbed} absorbed
        </span>
      </div>

      <div className="muted truncate" style={{ marginTop: 2 }}>
        {Object.entries(summary.byType)
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => `${count} ${type}`)
          .join(" · ")}
      </div>

      {/*
        Unresolved assets first and in red: a ref the tree names with no bytes
        behind it renders as nothing, and that is the single most likely reason
        a preview looks wrong.
      */}
      {summary.unresolvedAssets.length > 0 ? (
        <div style={{ color: "var(--fos-danger)", marginTop: 6 }}>
          {summary.unresolvedAssets.length} asset
          {summary.unresolvedAssets.length === 1 ? "" : "s"} could not be resolved —{" "}
          {summary.unresolvedAssets.join(", ")}
        </div>
      ) : null}

      {problems.length > 0 ? (
        <div style={{ marginTop: 6 }}>
          {problems.map(([kind, count]) => (
            <div key={kind} className="truncate" style={{ color: "var(--fos-warn)" }}>
              {count} {NOTE_LABELS[kind] ?? kind}
            </div>
          ))}
        </div>
      ) : null}

      {/* One example per problem kind. "9 decorative vectors" is a number
          nobody can act on; naming one says which layer to go and look at. */}
      {summary.examples.filter((e) => PROBLEM_KINDS.has(e.kind)).length > 0 ? (
        <details style={{ marginTop: 6 }}>
          <summary className="muted">what the compiler said</summary>
          <div style={{ marginTop: 4 }}>
            {summary.examples
              .filter((e) => PROBLEM_KINDS.has(e.kind))
              .map((example, i) => (
                <div key={`${example.kind}-${i}`} className="muted note-line">
                  {example.message}
                </div>
              ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
