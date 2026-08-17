/**
 * Asset ref resolution.
 *
 * `asset.*` refs are structured path keys, not opaque free strings. Resolution
 * is pure given a CDN context so every tenant and every environment can share
 * the same tree and still point at different hosts.
 *
 *   resolveAsset("asset.texture.stripes", { cdnBase: "https://cdn.example", tenant: "sb" })
 *   // -> "https://cdn.example/sb/textures/stripes.png"
 *
 * Local dev uses `cdnBase: "/public"` (or an empty base with a leading slash
 * on the first segment — see {@link resolveAsset}).
 *
 * Pure. No I/O.
 */

import { parseRef } from "./refs.js";

export interface AssetContext {
  /** Host + optional path prefix, no trailing slash required. */
  cdnBase: string;
  /** Tenant slug, e.g. `southern-brave`. */
  tenant: string;
  /** Optional cache-busting / release path segment. */
  version?: string;
  /**
   * Explicit URLs, keyed by `asset.texture.x` or the leaf `texture.x`.
   * Wins over the CDN convention so a run can point a texture at S3 (or, for
   * now, the tenant's production static host) without renaming files.
   */
  urls?: Record<string, string>;
}

/**
 * Local-dev default: files under the Next app's `public/` directory.
 * `resolveAsset("asset.texture.noise", LOCAL_ASSET_CONTEXT)` →
 * `/public/local/textures/noise.png` when the app serves `/public/*`, or
 * more commonly callers set `cdnBase: ""` and put assets under
 * `public/<tenant>/…` — the harness uses {@link LOCAL_ASSET_CONTEXT}.
 */
export const LOCAL_ASSET_CONTEXT: AssetContext = {
  cdnBase: "/public",
  tenant: "local",
};

/**
 * Pluralise the first leaf segment so `asset.texture.stripes` lands under
 * `textures/` rather than `texture/`. Already-plural segments pass through.
 */
function folderOf(kind: string): string {
  if (kind.endsWith("s")) return kind;
  return `${kind}s`;
}

/**
 * Resolve an `asset.*` ref to a concrete URL.
 *
 * @throws if `ref` is not an `asset.*` ref or has no leaf path.
 */
export function resolveAsset(ref: string, ctx: AssetContext): string {
  const parsed = parseRef(ref);
  if (!parsed || parsed.category !== "asset") {
    throw new Error(`resolveAsset: expected an asset.* ref, got ${JSON.stringify(ref)}`);
  }
  const explicit = ctx.urls?.[ref] ?? ctx.urls?.[parsed.leaf] ?? ctx.urls?.[`asset.${parsed.leaf}`];
  if (explicit) return explicit;
  const parts = parsed.leaf.split(".").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(
      `resolveAsset: asset ref must be asset.<kind>.<name>, got ${JSON.stringify(ref)}`,
    );
  }
  const [kind, ...rest] = parts;
  const folder = folderOf(kind!);
  const name = rest.join("/");
  const base = ctx.cdnBase.replace(/\/+$/, "");
  const tenant = ctx.tenant.replace(/^\/+|\/+$/g, "");
  const version = ctx.version?.replace(/^\/+|\/+$/g, "");
  const segments = [base, tenant, version, folder, `${name}.png`].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  // Preserve a leading slash when the base was absolute-path style ("/public")
  // or empty (root-relative "/local/...").
  const joined = segments.join("/");
  if (base.startsWith("/") || base === "") {
    return joined.startsWith("/") ? joined : `/${joined}`;
  }
  return joined;
}
