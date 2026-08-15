/**
 * Uint8Array → base64, no `btoa`. The sandbox may not have it, and a table
 * walk is what the tests can pin.
 *
 * PURE.
 */

const TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const hasB = i + 1 < bytes.length;
    const hasC = i + 2 < bytes.length;
    const b = hasB ? bytes[i + 1]! : 0;
    const c = hasC ? bytes[i + 2]! : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += TABLE[(triple >> 18) & 63];
    out += TABLE[(triple >> 12) & 63];
    out += hasB ? TABLE[(triple >> 6) & 63] : "=";
    out += hasC ? TABLE[triple & 63] : "=";
  }
  return out;
}
