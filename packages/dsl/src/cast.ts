/**
 * A CAST flow response, as a tree binds it.
 *
 * `GET /cast/api/flow/<workflowId>?template_id=…&page=n` answers
 *
 *   { "data": { "1": [ …items ] }, "meta": { "pagination": { … } } }
 *
 * The `"1"` is the PAGE NUMBER, not a node or output id — the CMS Listing
 * hook's JSONata writes `{ "data": { ($page): [...] } }`, and page 2 of the same
 * template comes back under `"2"`. A tree that binds `data.1` therefore renders
 * page one and nothing else, forever. So the tree never sees the envelope: it
 * binds `items`, and this is the one place that knows how pages are keyed.
 *
 * Mirrors `attachWorkflowOutput` in @sikit/renderer (page/services/kmp.service.ts)
 * so a template binds the same names in Studio as in production:
 *
 *   - up to two `.data` envelopes are peeled
 *   - numeric keys are pages, concatenated in page order
 *   - a bare array is the item list; `{ items }` is taken as is
 *   - any other object is a custom payload and is kept, keys and all
 *
 * The item shape inside is NOT normalised here. The hook's JSONata already
 * normalises every upstream API into one fixed shape per hook (CMS Listing:
 * `title`, `desc`, `thumbnail_image`, `detail_url`, `published_date`,
 * `asset_type_id`, `entities.primary.name`, …), and that shape is the contract
 * a tree binds to.
 *
 * PURE.
 */

export interface CastPagination {
  total?: number;
  count?: number;
  per_page?: number;
  current_page?: number;
  total_pages?: number;
  [key: string]: unknown;
}

export interface CastData {
  /** Every item, pages concatenated in page order. What a Repeater's `over` names. */
  items: unknown[];
  /** `meta.pagination` as the hook sent it, or null. */
  pagination: CastPagination | null;
  /** The page keys the response carried, in order — `["1"]` for a first fetch. */
  pages: string[];
  /** A non-list payload's own keys (a detail hook, a custom plugin). */
  [key: string]: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export function fromCastFlow(response: unknown): CastData {
  const pagination = paginationOf(response);

  let body: unknown = response;
  for (let i = 0; i < 2 && isObject(body) && "data" in body; i++) body = body.data;

  if (Array.isArray(body)) return { items: body, pagination, pages: [] };
  if (!isObject(body)) return { items: [], pagination, pages: [] };

  const pages = Object.keys(body)
    .filter((k) => /^\d+$/.test(k) && Array.isArray(body[k]))
    .sort((a, b) => Number(a) - Number(b));
  if (pages.length > 0) {
    return { items: pages.flatMap((k) => body[k] as unknown[]), pagination, pages };
  }

  if (Array.isArray(body.items)) return { ...body, items: body.items, pagination, pages: [] };
  return { ...body, items: [], pagination, pages: [] };
}

function paginationOf(response: unknown): CastPagination | null {
  if (!isObject(response)) return null;
  const meta = isObject(response.meta) ? response.meta : isObject(response.data) && isObject(response.data.meta) ? response.data.meta : null;
  return meta && isObject(meta.pagination) ? (meta.pagination as CastPagination) : null;
}
