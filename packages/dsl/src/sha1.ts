/**
 * SHA-1, in about sixty lines of arithmetic.
 *
 * Written out rather than imported from `node:crypto` for one reason: every
 * module this package considers pure imports nothing that could touch a disk,
 * a clock or the network, and `tests/purity.test.ts` enforces that by reading
 * the source. A hash is arithmetic — it has no business being the exception
 * that opens the door to `node:` imports in the pure half of the package, and
 * a signature that only works where Node's crypto exists is not portable to the
 * Figma sandbox the extractor runs in.
 *
 * NOT for security. This is a content address for grouping subtrees; SHA-1's
 * collision weakness is irrelevant to "are these two cards the same shape", and
 * nothing here authenticates anything.
 *
 * PURE. No imports at all.
 */

const K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6];

/** Lowercase hex digest of the UTF-8 bytes of `input`. */
export function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;

  // Message + 0x80 + zero padding + a big-endian 64-bit length, to a multiple of 64.
  const total = (Math.floor((bytes.length + 8) / 64) + 1) * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;

  // JS integers are exact to 2^53, so the high word comes from division rather
  // than a shift — `bitLength >>> 32` would be a no-op and silently wrong.
  const hi = Math.floor(bitLength / 0x100000000);
  const lo = bitLength >>> 0;
  for (let i = 0; i < 4; i++) {
    buf[total - 8 + i] = (hi >>> (24 - 8 * i)) & 0xff;
    buf[total - 4 + i] = (lo >>> (24 - 8 * i)) & 0xff;
  }

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);

  for (let chunk = 0; chunk < total; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      const j = chunk + i * 4;
      w[i] = ((buf[j]! << 24) | (buf[j + 1]! << 16) | (buf[j + 2]! << 8) | buf[j + 3]!) >>> 0;
    }
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!;
      w[i] = ((x << 1) | (x >>> 31)) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      const round = Math.floor(i / 20);
      const f =
        round === 0
          ? (b & c) | (~b & d)
          : round === 2
            ? (b & c) | (b & d) | (c & d)
            : b ^ c ^ d;
      const t = (((a << 5) | (a >>> 27)) + (f >>> 0) + e + K[round]! + w[i]!) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = t;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, "0")).join("");
}
