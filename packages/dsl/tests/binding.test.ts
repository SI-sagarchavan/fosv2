/**
 * The ref grammar, the pipes and `when` — one implementation for the web
 * renderer, the native bundler and the validator.
 *
 * The values are the real Delhi Capitals CMS Listing payload in
 * `fixtures/cast/`, so every case is a shape the hook actually emits.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  absolutize,
  evaluateWhen,
  fillImageRatio,
  formatDate,
  hasRef,
  mapRefPaths,
  parseRefs,
  predicateSchema,
  resolveTemplate,
} from "../src/binding.js";
import { fromCastFlow } from "../src/cast.js";

const cast = () =>
  fromCastFlow(JSON.parse(readFileSync(new URL("../fixtures/cast/dc-news.flow.json", import.meta.url), "utf8")));
const items = () => cast().items as Array<Record<string, unknown>>;
const scope = () => ({ news: cast() });

describe("the ref grammar", () => {
  it("parses a path and its pipe chain", () => {
    expect(parseRefs('on {a.published_date | date:"MMM DD, YYYY" | default:"soon"}')).toEqual([
      {
        text: '{a.published_date | date:"MMM DD, YYYY" | default:"soon"}',
        path: "a.published_date",
        pipes: [
          { name: "date", args: ["MMM DD, YYYY"] },
          { name: "default", args: ["soon"] },
        ],
      },
    ]);
  });

  it("indexes arrays with numeric segments", () => {
    expect(parseRefs("{news.items.0.title}")[0]?.path).toBe("news.items.0.title");
  });

  /**
   * The CDN's slot is in the DATA (`/static-assets/media/{{RATIO}}-…`), and a
   * hand-authored URL can carry it too. Reading it as the ref `{RATIO}` would
   * turn every such literal into an unresolved binding.
   */
  it("does not read the CDN's {{RATIO}} slot as a ref", () => {
    expect(parseRefs("/static-assets/media/{{RATIO}}-abc.jpeg")).toEqual([]);
    expect(hasRef("/static-assets/media/{{RATIO}}-abc.jpeg")).toBe(false);
    expect(hasRef("{article.title}")).toBe(true);
  });

  it("rewrites paths and leaves pipes alone", () => {
    expect(
      mapRefPaths('{news.items.4.published_date | date:"MMM DD"} · {x}', (p) =>
        p.startsWith("news.items.4.") ? `article.${p.slice("news.items.4.".length)}` : p,
      ),
    ).toBe('{article.published_date | date:"MMM DD"} · {x}');
  });
});

describe("resolveTemplate", () => {
  it("draws CAST fields through pipes", () => {
    const r = resolveTemplate('{news.items.0.title} · {news.items.0.published_date | date:"MMM DD, YYYY"}', scope());
    expect(r).toEqual({
      value: "Delhi Capitals Appoint Chaminda Vaas and Amit Mishra as Fast Bowling and Spin Bowling Coaches · Oct 21, 2026",
      unresolved: [],
    });
  });

  /** `duration: null` on a video with no runtime — the old interpolate printed "null". */
  it("draws a present-but-null field as nothing", () => {
    expect(items()[4]!.duration).toBeNull();
    expect(resolveTemplate("{news.items.4.duration}", scope())).toEqual({ value: "", unresolved: [] });
  });

  it("lets `default` stand in for null, empty and missing", () => {
    expect(resolveTemplate('{news.items.4.duration | default:"Watch"}', scope()).value).toBe("Watch");
    expect(resolveTemplate('{news.items.0.external_link | default:"—"}', scope()).value).toBe("—");
    expect(resolveTemplate('{news.items.0.nope | default:"—"}', scope())).toEqual({ value: "—", unresolved: [] });
  });

  it("keeps the literal and reports it for a missing path, an object, or an unknown pipe", () => {
    expect(resolveTemplate("{news.items.0.headline}", scope())).toEqual({
      value: "{news.items.0.headline}",
      unresolved: ["news.items.0.headline"],
    });
    expect(resolveTemplate("{news.items.0.entities}", scope()).unresolved).toEqual(["news.items.0.entities"]);
    expect(resolveTemplate("{news.items.0.title | shout}", scope()).unresolved).toEqual(["news.items.0.title"]);
  });
});

describe("formatDate — fanxp's token set, with an explicit zone", () => {
  const iso = "2026-10-21T10:29:00.000Z";

  it("speaks the production patterns", () => {
    expect(formatDate(iso, "DD-MM-YYYY", "UTC")).toBe("21-10-2026");
    expect(formatDate(iso, "MMM DD, YYYY", "UTC")).toBe("Oct 21, 2026");
    expect(formatDate(iso, "DDDD, MMMM DD", "UTC")).toBe("Wednesday, October 21");
    expect(formatDate(iso, "hh:mm a", "UTC")).toBe("10:29 AM");
    expect(formatDate(iso, "HH:mm", "Asia/Kolkata")).toBe("15:59");
  });

  it("moves the day with the zone, so the zone has to be explicit", () => {
    expect(formatDate("2026-10-21T20:00:00Z", "DD MMM", "UTC")).toBe("21 Oct");
    expect(formatDate("2026-10-21T20:00:00Z", "DD MMM", "Asia/Kolkata")).toBe("22 Oct");
  });

  it("reads an offset-less timestamp as UTC, not as the machine's zone", () => {
    expect(formatDate("2025-07-14T23:45:00", "DD MMM HH:mm", "UTC")).toBe("14 Jul 23:45");
  });

  it("gives up (so `default` can catch it) on garbage or an unknown zone", () => {
    expect(formatDate("not a date", "DD", "UTC")).toBeUndefined();
    expect(formatDate(iso, "DD", "Mars/Olympus")).toBeUndefined();
  });

  it("takes its zone from the render when the pipe names none", () => {
    expect(resolveTemplate('{d | date:"HH:mm"}', { d: iso }, { timeZone: "Asia/Kolkata" }).value).toBe("15:59");
    expect(resolveTemplate('{d | date:"HH:mm":"UTC"}', { d: iso }, { timeZone: "Asia/Kolkata" }).value).toBe("10:29");
  });
});

describe("when", () => {
  /** The asset-type switch fanxp hand-codes in its extension molecule. */
  it("picks videos out of a mixed listing", () => {
    const video = { path: "item.asset_type_id", eq: 4 };
    const kinds = items().map((item) => evaluateWhen(video, { item }));
    expect(kinds).toEqual([false, false, true, false, true, true, true, false]);
  });

  it("tests presence: a video with no runtime shows no duration chip", () => {
    const hasDuration = { path: "item.duration", exists: true };
    expect(items().map((item) => evaluateWhen(hasDuration, { item }))).toEqual([
      true, true, true, true, false, false, true, true,
    ]);
  });

  it("ANDs a list, and spells OR as `in`", () => {
    const runtimeVideo = [
      { path: "item.asset_type_id", eq: 4 },
      { path: "item.duration", exists: true },
    ];
    expect(items().filter((item) => evaluateWhen(runtimeVideo, { item }))).toHaveLength(2);
    expect(items().filter((item) => evaluateWhen({ path: "item.asset_type_id", in: [3, 4] }, { item }))).toHaveLength(4);
  });

  it("compares strictly — 4 is not \"4\"", () => {
    expect(evaluateWhen({ path: "x", eq: "4" }, { x: 4 })).toBe(false);
  });

  it("takes exactly one operator per condition", () => {
    expect(predicateSchema.safeParse({ path: "a.b", eq: 1 }).success).toBe(true);
    expect(predicateSchema.safeParse({ path: "a.b" }).success).toBe(false);
    expect(predicateSchema.safeParse({ path: "a.b", eq: 1, ne: 2 }).success).toBe(false);
    expect(predicateSchema.safeParse({ path: "a b", eq: 1 }).success).toBe(false);
    expect(predicateSchema.safeParse([]).success).toBe(false);
  });

  it("draws when the predicate is absent or malformed — S12 reports the malformed one", () => {
    expect(evaluateWhen(undefined, {})).toBe(true);
    expect(evaluateWhen({ nonsense: true }, {})).toBe(true);
  });
});

describe("images", () => {
  const thumb = "/static-assets/media/{{RATIO}}-5e88da59-5995-4de0-ac29-b6f10747349d.jpeg?v=1.02";

  it("fills the CDN slot from the Image's ratio, `0` when it has none", () => {
    expect(fillImageRatio(thumb, "16/9")).toBe("/static-assets/media/16-9-5e88da59-5995-4de0-ac29-b6f10747349d.jpeg?v=1.02");
    expect(fillImageRatio(thumb, "1/1")).toContain("/1-1-5e88da59");
    expect(fillImageRatio(thumb, undefined)).toContain("/0-5e88da59");
    expect(fillImageRatio("https://cdn/x.jpg", "1/1")).toBe("https://cdn/x.jpg");
  });

  it("anchors root-relative URLs to the tenant", () => {
    expect(absolutize("/static-assets/a.jpg", "https://dc.surface.fan-os.net/")).toBe(
      "https://dc.surface.fan-os.net/static-assets/a.jpg",
    );
    expect(absolutize("https://other/a.jpg", "https://dc.surface.fan-os.net")).toBe("https://other/a.jpg");
    expect(absolutize("//cdn/a.jpg", "https://dc.surface.fan-os.net")).toBe("//cdn/a.jpg");
    expect(absolutize("/a.jpg", undefined)).toBe("/a.jpg");
  });
});
