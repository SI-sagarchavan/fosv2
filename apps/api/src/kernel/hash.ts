/**
 * Content addressing.
 *
 * Domain, not infrastructure: "these are the same artifact" is a business rule
 * about identity, and it has to mean the same thing to the fs adapter, the S3
 * adapter, and the in-memory fake. `node:crypto` is a language primitive here,
 * not I/O — nothing below touches a disk, a clock, or the network.
 */
import { createHash } from "node:crypto";

export function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Digest of a JSON value, stable across key order. Two structurally identical
 * DSL trees must land on one artifact however they were serialised.
 */
export function digestOfJson(value: unknown): string {
  return digestOf(new TextEncoder().encode(canonicalJson(value)));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) out[k] = sortKeys(v);
  return out;
}

const DIGEST = /^[0-9a-f]{64}$/;

export function isDigest(value: string): boolean {
  return DIGEST.test(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
