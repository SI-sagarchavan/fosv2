/**
 * Minimal Next route that renders a fixture for visual inspection and
 * Playwright screenshots.
 *
 *   http://localhost:3415/render                        → player card at 281 (native)
 *   http://localhost:3415/render?card=news              → news card at 379 (native)
 *   http://localhost:3415/render?card=news&width=760
 *   http://localhost:3415/render?card=news&from=compiled → the same frame,
 *                                                          straight out of
 *                                                          @fanos/compile
 *
 * `from=compiled` is the comparison that matters: hand-authored trees carry
 * bindings, Repeaters and named icons that the deterministic compiler refuses
 * to guess, so the difference between the two views is exactly the work still
 * left to the semantic pass.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flatTreeSchema } from "@fanos/dsl";
import { emitCss, loadSurfaces, loadTheme } from "@fanos/tokens";
import { Render } from "../../src/components/Render";

const THEME = join(process.cwd(), "../tokens/fixtures/southern-brave.json");
const SURFACES = join(process.cwd(), "../tokens/surfaces/southern-brave.json");

/**
 * Each fixture records the width of the Figma frame it was generated from.
 * A fixed-aspect card is scaled as a whole; see Render's `designWidth`.
 */
const CARDS = {
  player: {
    slug: "player-card",
    designWidth: 281, // organism_web_cricket_playercard, 281x412
    page: "#172573",
  },
  fixtures: {
    slug: "fixture-card",
    designWidth: undefined,
    page: "#ffffff",
  },
  videos: {
    slug: "videos-section",
    // A full-width SECTION, not a card — it lays out at the page width.
    designWidth: undefined,
    page: "#0b0b0b",
  },
  newsletter: {
    slug: "newsletter-signup",
    // A full-width band: `justify: between` distributes the free space, so it
    // reproduces the 1366 design without being pinned to it.
    designWidth: undefined,
    page: "#ffffff",
  },
  news: {
    slug: "news-card",
    // NO designWidth. This is a FLOW component, not fixed-aspect art: at a
    // wider column you want more text per line at the token size, not 2x type.
    // Scaling is only right for a card whose whole composition is fixed.
    designWidth: undefined,
    page: "#eeeeee",
  },
} as const;

/**
 * Where a tree comes from.
 *
 * The compiler emits literal text rather than bindings, so `compiled` has no
 * data file — passing the hand-authored one would silently rebind it and hide
 * the very difference this view exists to show. It also needs its own surfaces,
 * because the paint it found has no name in the theme yet.
 */
const SOURCES = {
  hand: {
    label: "hand-authored",
    tree: (slug: string) => join(process.cwd(), `../dsl/fixtures/${slug}.json`),
    data: (slug: string) => join(process.cwd(), `fixtures/${slug}.data.json`),
    surfaces: SURFACES,
  },
  compiled: {
    label: "@fanos/compile",
    tree: (slug: string) => join(process.cwd(), `../compile/out/${slug}.json`),
    data: () => undefined,
    surfaces: join(process.cwd(), "../compile/out/surfaces.json"),
  },
} as const;

/** Local asset base that maps to Next's `public/` (served at `/`). */
const NEXT_ASSETS = { cdnBase: "", tenant: "local" } as const;

export default async function RenderPage({
  searchParams,
}: {
  searchParams: Promise<{ width?: string; card?: string; from?: string }>;
}) {
  const params = await searchParams;
  const key =
    params.card && params.card in CARDS ? (params.card as keyof typeof CARDS) : "player";
  const card = CARDS[key];
  const from = params.from === "compiled" ? "compiled" : "hand";
  const source = SOURCES[from];
  const width = Number(params.width ?? card.designWidth ?? 564);

  const treePath = source.tree(card.slug);
  let tree;
  let missing: string | undefined;
  try {
    tree = flatTreeSchema.parse(JSON.parse(readFileSync(treePath, "utf8")));
  } catch {
    missing = treePath;
  }
  const dataPath = source.data(card.slug);
  const data = dataPath ? (JSON.parse(readFileSync(dataPath, "utf8")) as Record<string, unknown>) : undefined;
  const { css } = emitCss(loadTheme(THEME), {
    surfaces: loadSurfaces(source.surfaces),
    // Surface textures resolve under /local/... which lives in public/
    assets: NEXT_ASSETS,
    scope: "root",
  });

  const tab = (value: "hand" | "compiled") => (
    <a
      key={value}
      href={`/render?card=${key}&from=${value}${params.width ? `&width=${params.width}` : ""}`}
      style={{
        padding: "4px 12px",
        borderRadius: 6,
        textDecoration: "none",
        fontFamily: "ui-monospace, monospace",
        fontSize: 12,
        background: from === value ? "#e10a15" : "rgba(127,127,127,0.25)",
        color: from === value ? "#fff" : "inherit",
      }}
    >
      {SOURCES[value].label}
    </a>
  );

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          padding: "10px 16px",
          background: "#111",
          color: "#ddd",
          fontFamily: "ui-monospace, monospace",
          fontSize: 12,
        }}
      >
        <strong style={{ marginRight: 8 }}>{card.slug}</strong>
        {tab("hand")}
        {tab("compiled")}
        <span style={{ marginLeft: "auto", opacity: 0.6 }}>
          {width}px{data ? "" : " · literal text, no bindings"}
        </span>
      </div>
      <div
        style={{
          padding: 40,
          display: "flex",
          justifyContent: "center",
          background: card.page,
          minHeight: "100vh",
        }}
      >
        {tree ? (
          <Render
            tree={tree}
            data={data}
            assets={NEXT_ASSETS}
            width={width}
            {...(card.designWidth ? { designWidth: card.designWidth } : {})}
          />
        ) : (
          <pre style={{ color: "#e10a15", fontFamily: "ui-monospace, monospace" }}>
            no tree at {missing}
            {"\n\n"}run: pnpm --filter @fanos/compile build && node packages/compile/dist/bin.js build …
          </pre>
        )}
      </div>
    </>
  );
}
