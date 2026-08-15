import { describe, expect, it } from "vitest";

import { createZip, crc32 } from "../src/zip";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("crc32", () => {
  it("matches the reference check values", () => {
    expect(crc32(bytes(""))).toBe(0);
    expect(crc32(bytes("123456789"))).toBe(0xcbf43926);
    expect(crc32(bytes("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });

  it("handles bytes above 0x7f", () => {
    expect(crc32(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(0x5bebbea5);
  });
});

describe("createZip", () => {
  const fixed = new Date(2026, 7, 6, 12, 0, 0);

  it("writes the three required signatures", () => {
    const zip = createZip([{ name: "a.txt", data: bytes("hello") }], fixed);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

    expect(view.getUint32(0, true)).toBe(0x04034b50); // local header
    // End of central directory is the last 22 bytes.
    expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(zip.length - 22 + 10, true)).toBe(1); // total entries
  });

  it("records every entry in the central directory", () => {
    const zip = createZip(
      [
        { name: "doc.ir.json", data: bytes("{}") },
        { name: "13744-75493.png", data: new Uint8Array([1, 2, 3]) },
        { name: "13744-75494.png", data: new Uint8Array([4, 5]) },
      ],
      fixed,
    );
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

    expect(view.getUint16(zip.length - 22 + 10, true)).toBe(3);

    const centralOffset = view.getUint32(zip.length - 22 + 16, true);
    expect(view.getUint32(centralOffset, true)).toBe(0x02014b50);

    // Central directory size + offset must account for everything before the EOCD.
    const centralSize = view.getUint32(zip.length - 22 + 12, true);
    expect(centralOffset + centralSize).toBe(zip.length - 22);
  });

  it("stores payloads verbatim with a matching crc", () => {
    const payload = bytes("the quick brown fox");
    const zip = createZip([{ name: "a.txt", data: payload }], fixed);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

    expect(view.getUint32(14, true)).toBe(crc32(payload));
    expect(view.getUint32(18, true)).toBe(payload.length); // compressed
    expect(view.getUint32(22, true)).toBe(payload.length); // uncompressed
    expect(view.getUint16(8, true)).toBe(0); // method: store

    const nameLength = view.getUint16(26, true);
    const start = 30 + nameLength;
    expect(Array.from(zip.subarray(start, start + payload.length))).toEqual(
      Array.from(payload),
    );
  });

  it("produces an empty but valid archive for no entries", () => {
    const zip = createZip([], fixed);
    expect(zip.length).toBe(22);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint32(0, true)).toBe(0x06054b50);
  });
});
