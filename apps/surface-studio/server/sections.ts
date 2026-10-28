/**
 * Generated sections — DSL trees authored without a Figma frame, served from disk.
 *
 *   GET /v1/sections        -> the sections on disk, as JSON
 *   GET /v1/sections/:name  -> one rendered as a page (?width= ?bg= as on /v1/preview)
 *
 * The silver and bronze tiers start here: no export, no run, no artifact — a
 * tree, the theme it was composed against, the surfaces it composed, and the
 * data it binds. So unlike `/v1/preview/:ref` this needs no control plane;
 * Studio "stores nothing" still holds, because the files live in the repo
 * (`packages/dsl/fixtures/sections/<name>/`) and travel with the DSL package.
 *
 * Each section is a folder with a `section.json` manifest. Paths in it are
 * relative to the folder. Data names map to a source, and today the only source
 * is a saved CAST flow response, normalised by `fromCastFlow` exactly as a live
 * one will be — swapping the fixture for the live flow URL is the data-layer
 * step, deliberately not taken yet.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";

import { fromCastFlow } from "@fanos/dsl";
import type { PreviewSource } from "./preview.js";

export interface SectionManifest {
  title: string;
  note?: string;
  tree: string;
  theme: string;
  /** Surface files, merged in order — later files win on a name clash. */
  surfaces?: string[];
  /** Name in the data bag -> where its value comes from. */
  data?: Record<string, { castFlow: string }>;
  origin?: string;
  timeZone?: string;
  background?: string;
}

export interface SectionSummary {
  name: string;
  title: string;
  href: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

let cachedRoot: string | null = null;

/**
 * `<@fanos/dsl>/fixtures/sections`, found from the package rather than a fixed
 * `../..` — which differs between running from source and from Vite's config
 * bundle. Walked by hand because `@fanos/dsl` exports only an `import` entry,
 * so `require.resolve` refuses it; realpath'd so the workspace symlink lands on
 * `packages/dsl` and the escape check below has a real directory to test.
 */
function sectionsRoot(): string {
  if (cachedRoot) return cachedRoot;
  for (const base of createRequire(import.meta.url).resolve.paths("@fanos/dsl") ?? []) {
    const dir = join(base, "@fanos", "dsl");
    if (existsSync(join(dir, "package.json"))) {
      cachedRoot = join(realpathSync(dir), "fixtures", "sections");
      return cachedRoot;
    }
  }
  throw new Error("sections: could not locate the @fanos/dsl package");
}

/** Files a manifest names must stay inside the workspace's `packages/`. */
function within(folder: string, rel: string): string {
  const packages = resolve(sectionsRoot(), "..", "..", "..");
  const path = resolve(folder, rel);
  if (!path.startsWith(packages + sep)) throw new Error(`section file "${rel}" escapes the workspace`);
  if (!existsSync(path)) throw new Error(`section file "${rel}" does not exist`);
  return path;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

export function listSections(): SectionSummary[] {
  const root = sectionsRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && NAME_RE.test(d.name) && existsSync(join(root, d.name, "section.json")))
    .map((d) => {
      const manifest = readJson(join(root, d.name, "section.json")) as SectionManifest;
      return { name: d.name, title: manifest.title, href: `/v1/sections/${d.name}` };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Everything `renderPreview` needs for one section, or null when there is no
 * such section. Throws on a manifest that names a missing or escaping file —
 * that is a broken section, not an absent one.
 */
export function loadSection(name: string): (PreviewSource & { title: string }) | null {
  if (!NAME_RE.test(name)) return null;
  const folder = join(sectionsRoot(), name);
  const manifestPath = join(folder, "section.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = readJson(manifestPath) as SectionManifest;

  const surfaces = (manifest.surfaces ?? [])
    .map((rel) => readJson(within(folder, rel)) as { assets?: Record<string, string>; surfaces?: Record<string, unknown> })
    .reduce(
      (acc, file) => ({
        assets: { ...acc.assets, ...(file.assets ?? {}) },
        surfaces: { ...acc.surfaces, ...(file.surfaces ?? {}) },
      }),
      { assets: {} as Record<string, string>, surfaces: {} as Record<string, unknown> },
    );

  const data = Object.fromEntries(
    Object.entries(manifest.data ?? {}).map(([key, source]) => [key, fromCastFlow(readJson(within(folder, source.castFlow)))]),
  );

  return {
    title: manifest.title,
    tree: readJson(within(folder, manifest.tree)),
    theme: readJson(within(folder, manifest.theme)),
    ...(manifest.surfaces?.length ? { surfaces } : {}),
    ...(Object.keys(data).length ? { data } : {}),
    ...(manifest.origin ? { origin: manifest.origin } : {}),
    ...(manifest.timeZone ? { timeZone: manifest.timeZone } : {}),
    ...(manifest.background ? { background: manifest.background } : {}),
  };
}

/**
 * CMS Listing roles the news section is built from. The numbers are the hook's
 * `asset_type_id`: 1 news, 3 gallery, 4 video (including reels). The tree's
 * `when` tags use the same numbers.
 */
export const LISTING_WIDGETS = [
  { id: "news", label: "News", assetType: 1 },
  { id: "video", label: "Video", assetType: 4 },
  { id: "photos", label: "Photos", assetType: 3 },
] as const;

export type ListingWidgetId = (typeof LISTING_WIDGETS)[number]["id"];

export interface SectionWidget {
  id: ListingWidgetId;
  label: string;
  assetType: number;
  count: number;
}

export interface SectionItem {
  title: string;
  kind: ListingWidgetId | "other";
  /** The hook's own label, e.g. "Reels", when the item carries one. */
  label: string | null;
  published: string | null;
  url: string | null;
}

export interface SectionDetail {
  name: string;
  title: string;
  href: string;
  /** `meta.pagination.total` when the hook sent it, otherwise the items in hand. */
  total: number;
  widgets: SectionWidget[];
  items: SectionItem[];
}

/**
 * The section as the product sees it: one listing, split into news, video and
 * photos. Null for an unknown or unsafe name. A broken manifest still throws,
 * same as {@link loadSection}.
 */
export function describeSection(name: string): SectionDetail | null {
  const section = loadSection(name);
  if (!section) return null;

  const bag = section.data?.news;
  const news = bag && typeof bag === "object" ? (bag as { items?: unknown[]; pagination?: { total?: number } }) : undefined;
  const rows = (Array.isArray(news?.items) ? news.items : []).map((item) => toItem(item, section.origin));
  const total = typeof news?.pagination?.total === "number" ? news.pagination.total : rows.length;

  return {
    name,
    title: section.title,
    href: `/v1/sections/${name}`,
    total,
    widgets: LISTING_WIDGETS.map((widget) => ({
      ...widget,
      count: rows.filter((row) => row.kind === widget.id).length,
    })),
    items: rows,
  };
}

function toItem(raw: unknown, origin: string | undefined): SectionItem {
  const item = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const entities = item.entities !== null && typeof item.entities === "object" ? (item.entities as Record<string, unknown>) : {};
  const secondary =
    entities.secondary !== null && typeof entities.secondary === "object"
      ? (entities.secondary as Record<string, unknown>).name
      : null;
  const assetType = item.asset_type_id;
  const widget = LISTING_WIDGETS.find((entry) => entry.assetType === assetType);
  return {
    title: typeof item.title === "string" && item.title.trim() ? item.title : "Untitled",
    kind: widget?.id ?? "other",
    label: typeof secondary === "string" ? secondary : null,
    published: typeof item.published_date === "string" ? item.published_date : null,
    url: absolute(origin, typeof item.detail_url === "string" ? item.detail_url : null),
  };
}

function absolute(origin: string | undefined, href: string | null): string | null {
  if (!href) return null;
  if (/^https?:\/\//.test(href)) return href;
  if (!origin) return href;
  return `${origin.replace(/\/$/, "")}${href.startsWith("/") ? href : `/${href}`}`;
}
