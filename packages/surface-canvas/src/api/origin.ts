/**
 * Where the plugin is allowed to call.
 *
 * The list is the same set as `devAllowedDomains` in the manifest. A stored
 * origin that is not on it is ignored, so clientStorage cannot point the
 * plugin at an unexpected host. Production hosts land here and in
 * `allowedDomains` together, when there is one.
 *
 * PURE.
 */

export const DEFAULT_API_ORIGIN = "http://localhost:3000";

export const API_ORIGINS = [DEFAULT_API_ORIGIN] as const;

export type ApiOrigin = (typeof API_ORIGINS)[number];

/** Strip a trailing slash. Anything else is left for the allowlist to reject. */
export function normalizeOrigin(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * A stored value, or the default. Unknown hosts fall back rather than fail
 * closed: a bad string in clientStorage should not disable a localhost
 * dashboard the designer is actually running.
 */
export function resolveOrigin(raw: unknown): ApiOrigin {
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_API_ORIGIN;
  const origin = normalizeOrigin(raw);
  return (API_ORIGINS as readonly string[]).includes(origin)
    ? (origin as ApiOrigin)
    : DEFAULT_API_ORIGIN;
}
