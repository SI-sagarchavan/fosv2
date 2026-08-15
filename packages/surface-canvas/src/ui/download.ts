/**
 * File saving, lifted from the old extractor iframe unchanged.
 *
 * Saving is deliberately click-driven. Figma desktop answers every download with
 * a native modal save panel, and any download queued while that panel is open is
 * dropped on the floor — so a burst of anchor clicks silently loses everything
 * after the first file. One user gesture, one saved file.
 */
import { createZip } from "../zip";

/** A zip entry whose bytes we own outright, so they are also valid BlobParts. */
export type OwnedEntry = { name: string; data: Uint8Array<ArrayBuffer> };

export function save(filename: string, blob: Blob): void {
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

export function saveZip(zipName: string, files: OwnedEntry[]): void {
  const zip = createZip(files);
  save(zipName, new Blob([zip], { type: "application/zip" }));
}

export function saveOne(file: OwnedEntry): void {
  save(file.name, new Blob([file.data]));
}

/**
 * Byte arrays survive postMessage as a real Uint8Array on current Figma builds,
 * but older ones hand over a plain array or an index-keyed object. Normalize,
 * and copy into a buffer we own — a transferred view is not a valid BlobPart.
 */
export function toBytes(
  input: Uint8Array | number[] | Record<string, number>,
): Uint8Array<ArrayBuffer> {
  const values: ArrayLike<number> =
    input instanceof Uint8Array || Array.isArray(input) ? input : Object.values(input);
  const bytes = new Uint8Array(new ArrayBuffer(values.length));
  bytes.set(values);
  return bytes;
}

export function encodeUtf8(text: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(text);
  const bytes = new Uint8Array(new ArrayBuffer(encoded.length));
  bytes.set(encoded);
  return bytes;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
