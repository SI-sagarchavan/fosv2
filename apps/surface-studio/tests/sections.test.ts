/**
 * Generated sections — a tree with no Figma behind it, rendered from disk.
 *
 * Runs against the real section in `packages/dsl/fixtures/sections/`, the Delhi
 * Capitals news band composed from scratch and bound to a saved CAST response.
 */

import { describe, expect, it } from "vitest";
import { describeSection, listSections, loadSection } from "../server/sections.js";
import { renderPreview } from "../server/preview.js";

const NAME = "straight-from-the-capital";

describe("sections on disk", () => {
  it("lists the generated section", () => {
    expect(listSections()).toContainEqual({
      name: NAME,
      title: "Straight from the Capital",
      href: `/v1/sections/${NAME}`,
    });
  });

  it("loads its tree, merged surfaces and normalised CAST data", () => {
    const s = loadSection(NAME)!;
    const surfaces = s.surfaces as { surfaces: Record<string, unknown> };
    // The theme's own set, with the section's composed surfaces on top.
    expect(surfaces.surfaces).toHaveProperty("card_stat");
    expect(surfaces.surfaces).toHaveProperty("dispatch_band");
    // Bound as `news.items`, never the raw page bucket `data.1`.
    const news = s.data!.news as { items: unknown[]; pages: string[] };
    expect(news.items).toHaveLength(8);
    expect(news.pages).toEqual(["1"]);
    expect(s.origin).toBe("https://dc.surface.fan-os.net");
  });

  it("answers null for an unknown or unsafe name", () => {
    expect(loadSection("no-such-section")).toBeNull();
    expect(loadSection("../cast")).toBeNull();
    expect(loadSection("Straight")).toBeNull();
    expect(describeSection("../cast")).toBeNull();
  });

  it("splits the listing into news, video and photos", () => {
    const detail = describeSection(NAME)!;
    expect(detail.title).toBe("Straight from the Capital");
    expect(detail.total).toBe(2551);
    expect(detail.widgets).toEqual([
      { id: "news", label: "News", assetType: 1, count: 4 },
      { id: "video", label: "Video", assetType: 4, count: 4 },
      { id: "photos", label: "Photos", assetType: 3, count: 0 },
    ]);
    expect(detail.items[0]).toMatchObject({
      kind: "news",
      label: "News",
      url: "https://dc.surface.fan-os.net/news/delhi-capitals-appoint-chaminda-vaas-and-amit-mishra-as-fast-bowling-and-spin-bowling-coaches",
    });
    expect(detail.items.filter((item) => item.label === "Reels")).toHaveLength(2);
  });

  it("renders live: tenant images, tenant links, responsive layout", async () => {
    const { title: _title, ...source } = loadSection(NAME)!;
    const { html } = await renderPreview(source);
    expect(html).toContain("Delhi Capitals Appoint Chaminda Vaas");
    expect(html).toContain('src="https://dc.surface.fan-os.net/static-assets/media/4-3-5e88da59');
    expect(html).toContain('href="https://dc.surface.fan-os.net/news/delhi-capitals-appoint-chaminda-vaas');
    // `{ base: column, lg: row }` must reach the page as a breakpoint chain.
    expect(html).toContain("var(--flex-direction-cur, var(--flex-direction-base))");
    expect(html).not.toMatch(/\{(news|story|clip)\.[^}]*\}/);
  });
});
