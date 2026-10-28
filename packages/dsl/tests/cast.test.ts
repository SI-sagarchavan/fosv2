/**
 * `fromCastFlow` — the envelope a tree never sees.
 *
 * Pinned against `attachWorkflowOutput` in @sikit/renderer: same envelopes
 * peeled, same reading of numeric keys as PAGES.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromCastFlow } from "../src/cast.js";

const response = () =>
  JSON.parse(readFileSync(new URL("../fixtures/cast/dc-news.flow.json", import.meta.url), "utf8")) as {
    data: Record<string, unknown[]>;
    meta: { pagination: Record<string, number> };
  };

describe("fromCastFlow", () => {
  it("turns the real CMS Listing response into items + pagination", () => {
    const out = fromCastFlow(response());
    expect(out.items).toHaveLength(8);
    expect(out.items).toEqual(response().data["1"]);
    expect(out.pages).toEqual(["1"]);
    expect(out.pagination).toMatchObject({ total: 2551, current_page: 1, total_pages: 319, per_page: 8 });
  });

  /** Page 2 of the same template is keyed "2" — the reason a tree must not bind `data.1`. */
  it("concatenates page buckets in PAGE order, not key order", () => {
    const out = fromCastFlow({ data: { "10": ["j"], "2": ["b"], "1": ["a"] } });
    expect(out.items).toEqual(["a", "b", "j"]);
    expect(out.pages).toEqual(["1", "2", "10"]);
  });

  it("peels up to two data envelopes", () => {
    expect(fromCastFlow({ data: { data: { "1": [1, 2] } } }).items).toEqual([1, 2]);
  });

  it("takes a bare array and an `items` object as the list", () => {
    expect(fromCastFlow({ data: [1, 2, 3] }).items).toEqual([1, 2, 3]);
    expect(fromCastFlow({ data: { items: ["x"], title: "Latest" } })).toMatchObject({ items: ["x"], title: "Latest" });
  });

  it("keeps a custom payload's own keys, with an empty list", () => {
    const out = fromCastFlow({ data: { standings: { group: "A" } } });
    expect(out).toMatchObject({ items: [], standings: { group: "A" }, pagination: null, pages: [] });
  });

  it("survives nothing at all", () => {
    expect(fromCastFlow(null)).toEqual({ items: [], pagination: null, pages: [] });
  });
});
