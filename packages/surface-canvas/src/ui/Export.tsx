/**
 * Export tab. Production sends the walk to Surface Studio. The ZIP is the
 * escape hatch — same files, on disk, for when the board is not running.
 */
import type { JSX } from "react";
import { useMemo } from "react";
import type { ExportPublish } from "../protocol.js";
import { encodeUtf8, formatBytes, saveOne, saveZip, toBytes, type OwnedEntry } from "./download.js";
import { send } from "./main.js";
import type { StudioState } from "./state.js";

export function ExportTab({ state }: { state: StudioState }): JSX.Element {
  const result = state.exportResult;
  const frame = state.report?.rootName || state.selectionName || "this frame";
  const publish = state.exportPublish;

  const files: OwnedEntry[] = useMemo(() => {
    if (!result) return [];
    return [
      { name: result.jsonName, data: encodeUtf8(result.json) },
      ...result.screenshots.map((shot) => ({ name: shot.name, data: toBytes(shot.bytes) })),
    ];
  }, [result]);

  const zipName = result ? `${result.jsonName.replace(/\.ir\.json$/, "")}.zip` : "";
  const summary = result?.summary ?? {};
  const num = (key: string) => (typeof summary[key] === "number" ? (summary[key] as number) : 0);
  const schemaOk = summary["schemaValid"] !== false;
  const errors = num("extractionErrors");
  const loose = num("looseCount");
  const truncated = Boolean(summary["screenshotsTruncated"]);
  const sending = state.busy;

  return (
    <div className="scroll">
      <div className="section">
        <div style={{ fontWeight: 600 }}>Send “{frame}”</div>
        <div className="muted" style={{ margin: "4px 0 10px" }}>
          Surface Studio gets the IR and section PNGs. The ZIP is for testing.
        </div>

        <button
          className="primary"
          style={{ width: "100%" }}
          disabled={sending}
          onClick={() => send({ type: "publish-export" })}
        >
          {sending ? state.exportProgress || "Sending…" : result ? "Send again" : "Send to Surface Studio"}
        </button>

        {!result ? (
          <button
            className="outline"
            style={{ width: "100%", marginTop: 8 }}
            disabled={sending}
            onClick={() => send({ type: "export-ir" })}
            title="Walks the frame and keeps the files here. Nothing is posted."
          >
            Export locally
          </button>
        ) : (
          <button
            className={publish?.kind === "failed" ? "primary" : "outline"}
            style={{ width: "100%", marginTop: 8 }}
            onClick={() => saveZip(zipName, files)}
            title="Same files as the send. Use this when the board is down."
          >
            Save ZIP · {files.length} {files.length === 1 ? "file" : "files"}
          </button>
        )}

        {publish ? <PublishLine publish={publish} /> : null}
      </div>

      {result ? (
        <>
          <div className="section">
            <div className="row" style={{ marginBottom: 6 }}>
              <span className="grow">
                {num("nodeCount").toLocaleString()} layers
                <span className="muted"> · </span>
                {num("coveragePercent")}% bound
                <span className="muted"> · </span>
                {num("screenshotCount")} {num("screenshotCount") === 1 ? "PNG" : "PNGs"}
              </span>
              <span className="muted">{(num("durationMs") / 1000).toFixed(1)}s</span>
            </div>

            {loose > 0 ? (
              <div className="muted">
                {loose} {loose === 1 ? "value isn’t" : "values aren’t"} bound — Health can fix those.
              </div>
            ) : null}
            {errors > 0 ? (
              <div style={{ color: "var(--fos-danger)" }}>
                {errors} {errors === 1 ? "layer" : "layers"} failed to read
              </div>
            ) : null}
            {!schemaOk ? (
              <div style={{ color: "var(--fos-danger)" }}>
                Schema invalid{typeof summary["schemaError"] === "string" ? ` — ${summary["schemaError"]}` : ""}
              </div>
            ) : null}
            {truncated ? (
              <div className="muted">
                Screenshots capped at {num("screenshotCount")} of {num("screenshotCandidates")}.
              </div>
            ) : null}
          </div>

          <div className="section" style={{ paddingTop: 6, paddingBottom: 6 }}>
            {files.map((file) => (
              <button
                key={file.name}
                className="ghost row file-row"
                onClick={() => saveOne(file)}
                title={`Save ${file.name}`}
              >
                <span className="pill">{file.name.endsWith(".png") ? "PNG" : "JSON"}</span>
                <span className="grow truncate">{displayName(file.name)}</span>
                <span className="muted">{formatBytes(file.data.length)}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function PublishLine({ publish }: { publish: ExportPublish }): JSX.Element {
  if (publish.kind === "sent") {
    return (
      <div className="muted" style={{ marginTop: 10 }}>
        On Surface Studio · {hostOf(publish.origin)}
      </div>
    );
  }
  if (publish.kind === "failed") {
    return (
      <div style={{ color: "var(--fos-danger)", marginTop: 10 }}>
        Couldn’t send — {publish.message} Save ZIP and keep working.
      </div>
    );
  }
  return (
    <div className="muted" style={{ marginTop: 10 }}>
      Local only. Nothing was posted.
    </div>
  );
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** Drop the trailing node-id suffix for the list; the file on disk still has it. */
function displayName(name: string): string {
  return name.replace(/-\d+-\d+(?=\.(?:ir\.json|png)$)/, "");
}
