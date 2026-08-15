/**
 * Minimal store-only (no compression) ZIP writer.
 *
 * Pure, dependency-free, no Figma and no DOM — the UI bundles it to hand the
 * user one file instead of N. PNGs are already deflated, so storing costs
 * nothing but keeps this under a hundred lines and avoids a dependency.
 *
 * Format: APPNOTE.TXT 6.3.2, sections 4.3.7 (local header), 4.3.12 (central
 * directory) and 4.3.16 (end of central directory).
 */

export type ZipEntry = { name: string; data: Uint8Array };

let crcTable: Uint32Array | null = null;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  crcTable = t;
  return t;
}

export function crc32(data: Uint8Array): number {
  const t = table();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (t[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP inherits MS-DOS packed date/time; anything before 1980 is unrepresentable. */
function dosDateTime(date: Date): { time: number; dateBits: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      (Math.floor(date.getSeconds() / 2) & 0x1f),
    dateBits: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** ZIP entry names are bytes; keep them ASCII so no flag-bit 11 handling is needed. */
function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[i] = code < 0x80 ? code : 0x5f; // "_"
  }
  return out;
}

class Writer {
  private bytes: Uint8Array;
  private length = 0;

  constructor(capacity: number) {
    this.bytes = new Uint8Array(new ArrayBuffer(capacity));
  }

  get offset(): number {
    return this.length;
  }

  u16(value: number): void {
    this.bytes[this.length++] = value & 0xff;
    this.bytes[this.length++] = (value >>> 8) & 0xff;
  }

  u32(value: number): void {
    this.u16(value & 0xffff);
    this.u16((value >>> 16) & 0xffff);
  }

  raw(data: Uint8Array): void {
    this.bytes.set(data, this.length);
    this.length += data.length;
  }

  done(): Uint8Array<ArrayBuffer> {
    return this.bytes.subarray(0, this.length) as Uint8Array<ArrayBuffer>;
  }
}

export function createZip(entries: ZipEntry[], now: Date = new Date()): Uint8Array<ArrayBuffer> {
  const { time, dateBits } = dosDateTime(now);
  const prepared = entries.map((entry) => ({
    nameBytes: asciiBytes(entry.name),
    data: entry.data,
    crc: crc32(entry.data),
    offset: 0,
  }));

  const total = prepared.reduce(
    (sum, e) => sum + 30 + e.nameBytes.length + e.data.length + 46 + e.nameBytes.length,
    22,
  );
  const out = new Writer(total);

  for (const entry of prepared) {
    entry.offset = out.offset;
    out.u32(0x04034b50); // local file header
    out.u16(20); // version needed
    out.u16(0); // flags
    out.u16(0); // method: store
    out.u16(time);
    out.u16(dateBits);
    out.u32(entry.crc);
    out.u32(entry.data.length); // compressed size == uncompressed
    out.u32(entry.data.length);
    out.u16(entry.nameBytes.length);
    out.u16(0); // extra field length
    out.raw(entry.nameBytes);
    out.raw(entry.data);
  }

  const centralStart = out.offset;
  for (const entry of prepared) {
    out.u32(0x02014b50); // central directory header
    out.u16(20); // version made by
    out.u16(20); // version needed
    out.u16(0); // flags
    out.u16(0); // method
    out.u16(time);
    out.u16(dateBits);
    out.u32(entry.crc);
    out.u32(entry.data.length);
    out.u32(entry.data.length);
    out.u16(entry.nameBytes.length);
    out.u16(0); // extra
    out.u16(0); // comment
    out.u16(0); // disk number start
    out.u16(0); // internal attributes
    out.u32(0); // external attributes
    out.u32(entry.offset);
    out.raw(entry.nameBytes);
  }
  const centralSize = out.offset - centralStart;

  out.u32(0x06054b50); // end of central directory
  out.u16(0); // this disk
  out.u16(0); // disk with central directory
  out.u16(prepared.length);
  out.u16(prepared.length);
  out.u32(centralSize);
  out.u32(centralStart);
  out.u16(0); // comment length

  return out.done();
}
