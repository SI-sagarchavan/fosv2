/**
 * FanOS IR Extractor — iframe side.
 *
 * Owns the button, the progress line, the summary, and the actual file saves.
 * The sandbox cannot touch the DOM or write files, so everything arrives here
 * over postMessage.
 *
 * Saving is deliberately click-driven. Figma desktop answers every download
 * with a native modal save panel, and any download queued while that panel is
 * open is dropped on the floor — so a burst of anchor clicks silently loses
 * everything after the first file. One user gesture, one saved file.
 */
import { createZip } from "./zip";

/** A zip entry whose bytes we own outright, so they are also valid BlobParts. */
type OwnedEntry = { name: string; data: Uint8Array<ArrayBuffer> };

type Summary = {
  nodeCount: number;
  screenshotCount: number;
  skippedInvisible: number;
  extractionErrors: number;
  unboundCount: number;
  boundCount: number;
  unboundPercent: number;
  screenshotsTruncated: boolean;
  screenshotCandidates: number;
  durationMs: number;
  schemaValid: boolean;
  schemaError?: string;
};

type PluginMessage =
  | { type: "selection"; count: number; name: string | null }
  | { type: "progress"; message: string; nodes: number }
  | { type: "error"; message: string }
  | {
      type: "done";
      jsonName: string;
      json: string;
      screenshots: Array<{ name: string; nodeId: string; bytes: Uint8Array }>;
      summary: Summary;
    };

const exportButton = document.getElementById("export") as HTMLButtonElement;
const selectionLine = document.getElementById("selection") as HTMLElement;
const progressLine = document.getElementById("progress") as HTMLElement;
const summaryBox = document.getElementById("summary") as HTMLElement;
const statsList = document.getElementById("stats") as HTMLElement;
const filesLine = document.getElementById("files") as HTMLElement;
const saveAllButton = document.getElementById("saveAll") as HTMLButtonElement;
const hintLine = document.getElementById("hint") as HTMLElement;
const fileLinks = document.getElementById("fileLinks") as HTMLElement;

/** Object URLs from the previous run, revoked when a new run starts. */
let liveUrls: string[] = [];

exportButton.addEventListener("click", () => {
  exportButton.disabled = true;
  summaryBox.classList.remove("visible");
  releaseUrls();
  setProgress("Starting…", false);
  parent.postMessage({ pluginMessage: { type: "export" } }, "*");
});

window.onmessage = (event: MessageEvent) => {
  const msg = event.data?.pluginMessage as PluginMessage | undefined;
  if (!msg) return;

  switch (msg.type) {
    case "selection":
      selectionLine.textContent =
        msg.count === 1
          ? `Selected: ${msg.name}`
          : msg.count === 0
            ? "Select one root frame to begin."
            : `${msg.count} nodes selected — select exactly one.`;
      break;

    case "progress":
      setProgress(msg.message, false);
      break;

    case "error":
      setProgress(msg.message, true);
      exportButton.disabled = false;
      break;

    case "done":
      finish(msg);
      break;
  }
};

function setProgress(text: string, isError: boolean): void {
  progressLine.textContent = text;
  progressLine.classList.toggle("error", isError);
}

function finish(msg: Extract<PluginMessage, { type: "done" }>): void {
  const jsonBytes = encodeUtf8(msg.json);
  const files: OwnedEntry[] = [
    { name: msg.jsonName, data: jsonBytes },
    ...msg.screenshots.map((shot) => ({ name: shot.name, data: toBytes(shot.bytes) })),
  ];

  const s = msg.summary;
  renderStats([
    ["Nodes", String(s.nodeCount)],
    [
      "Screenshots",
      `${s.screenshotCount}${s.screenshotsTruncated ? ` / ${s.screenshotCandidates}` : ""}`,
    ],
    ["Unbound", `${s.unboundPercent}%`, s.unboundPercent > 25],
    ["Bound values", String(s.boundCount)],
    ["Skipped (hidden)", String(s.skippedInvisible)],
    ["Extraction errors", String(s.extractionErrors), s.extractionErrors > 0],
    ["Schema", s.schemaValid ? "valid" : "INVALID", !s.schemaValid],
    ["Duration", `${(s.durationMs / 1000).toFixed(1)}s`],
  ]);

  renderDownloads(msg.jsonName, files);

  filesLine.textContent = s.schemaError ? `Schema: ${s.schemaError}` : "";
  summaryBox.classList.add("visible");
  setProgress(`Ready — ${files.length} file${files.length === 1 ? "" : "s"} to save.`, false);
  exportButton.disabled = false;
}

/**
 * One button saves everything as a single ZIP (one save panel), and every file
 * is also individually clickable for anyone who wants them loose on disk.
 */
function renderDownloads(jsonName: string, files: OwnedEntry[]): void {
  const zipName = `${jsonName.replace(/\.ir\.json$/, "")}.ir.zip`;

  saveAllButton.textContent = `Save all ${files.length} files (${zipName})`;
  saveAllButton.onclick = () => {
    const zip = createZip(files);
    save(zipName, new Blob([zip], { type: "application/zip" }));
  };

  hintLine.textContent =
    "Figma's save panel blocks queued downloads, so each file is saved on click.";

  fileLinks.textContent = "";
  for (const file of files) {
    const url = URL.createObjectURL(new Blob([file.data]));
    liveUrls.push(url);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.textContent = `${file.name} — ${formatBytes(file.data.length)}`;
    fileLinks.appendChild(link);
  }
}

function renderStats(rows: Array<[string, string, boolean?]>): void {
  statsList.textContent = "";
  for (const [label, value, warn] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    if (warn) dd.className = "warn";
    statsList.append(dt, dd);
  }
}

function save(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking synchronously races the save panel; give it room.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function releaseUrls(): void {
  for (const url of liveUrls) URL.revokeObjectURL(url);
  liveUrls = [];
  fileLinks.textContent = "";
  saveAllButton.onclick = null;
}

/**
 * Byte arrays survive postMessage as a real Uint8Array on current Figma builds,
 * but older ones hand over a plain array or an index-keyed object. Normalize,
 * and copy into a buffer we own — a transferred view is not a valid BlobPart.
 */
function toBytes(
  input: Uint8Array | number[] | Record<string, number>,
): Uint8Array<ArrayBuffer> {
  const values: ArrayLike<number> =
    input instanceof Uint8Array || Array.isArray(input) ? input : Object.values(input);
  const bytes = new Uint8Array(new ArrayBuffer(values.length));
  bytes.set(values);
  return bytes;
}

function encodeUtf8(text: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(text);
  const bytes = new Uint8Array(new ArrayBuffer(encoded.length));
  bytes.set(encoded);
  return bytes;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
