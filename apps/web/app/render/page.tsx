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
import { Render } from "@fanos/renderer";

const THEME = join(process.cwd(), "../../packages/tokens/fixtures/southern-brave.json");
const SURFACES = join(process.cwd(), "../../packages/tokens/surfaces/southern-brave.json");

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
  newsSection: {
    slug: "news-section",
    // The whole three-column band from examples/news-section. A SECTION, so it
    // lays out at the page width rather than scaling as fixed-aspect art.
    designWidth: undefined,
    // The Figma export has a transparent background; this is the page behind it.
    page: "#0b0b0b",
    /**
     * This frame lives in examples/, not in the shared fixture directories, and
     * it has NO hand-authored tree — nobody wrote one, which is the whole point
     * of the example. Listing the sources it really has keeps the tabs honest
     * instead of offering a link that 500s.
     */
    only: ["compiled", "repaired"],
    paths: {
      compiled: {
        tree: example("news-section", "out/1b-compiled-section.dsl.json"),
        surfaces: example("news-section", "out/surfaces.json"),
      },
      repaired: {
        tree: example("news-section", "out/2b-section.dsl.json"),
        data: example("news-section", "data.json"),
        surfaces: example("news-section", "out/surfaces.json"),
      },
    },
    build: "node examples/news-section/pipeline.mjs",
  },
  ticketsHero: {
    slug: "tickets-section",
    designWidth: undefined,
    // A full-bleed hero: its own plate is the background.
    page: "#0b0b0b",
    only: ["compiled", "repaired"],
    paths: {
      compiled: {
        tree: example("tickets-section", "out/1b-compiled-section.dsl.json"),
        surfaces: example("tickets-section", "out/surfaces.json"),
      },
      repaired: {
        tree: example("tickets-section", "out/2b-section.dsl.json"),
        data: example("tickets-section", "data.json"),
        surfaces: example("tickets-section", "out/surfaces.json"),
      },
    },
    build: "node examples/tickets-section/pipeline.mjs",
  },
  photosPage: {
    slug: "photos-page",
    designWidth: undefined,
    page: "#0b0b0b",
    only: ["compiled", "repaired"],
    paths: {
      compiled: {
        tree: example("photos-page", "out/1b-compiled-section.dsl.json"),
        surfaces: example("photos-page", "out/surfaces.json"),
      },
      repaired: {
        tree: example("photos-page", "out/2b-section.dsl.json"),
        data: example("photos-page", "data.json"),
        surfaces: example("photos-page", "out/surfaces.json"),
      },
    },
    build: "node examples/photos-page/pipeline.mjs",
  },
  newsPage: {
    slug: "news-page",
    designWidth: undefined,
    page: "#0b0b0b",
    only: ["compiled", "repaired"],
    paths: {
      compiled: {
        tree: example("news-page", "out/1b-compiled-section.dsl.json"),
        surfaces: example("news-page", "out/surfaces.json"),
      },
      repaired: {
        tree: example("news-page", "out/2b-section.dsl.json"),
        data: example("news-page", "data.json"),
        surfaces: example("news-page", "out/surfaces.json"),
      },
    },
    build: "node examples/news-page/pipeline.mjs",
  },
  mobileMenu: {
    slug: "mobile-menu",
    // A 375-wide MOBILE frame. No designWidth: it should lay out at mobile type
    // sizes, not be a scaled-down desktop.
    designWidth: undefined,
    page: "#0b0b0b",
    only: ["compiled", "repaired"],
    paths: {
      compiled: {
        tree: example("mobile-menu", "out/1b-compiled-section.dsl.json"),
        surfaces: example("mobile-menu", "out/surfaces.json"),
      },
      repaired: {
        tree: example("mobile-menu", "out/2b-section.dsl.json"),
        data: example("mobile-menu", "data.json"),
        surfaces: example("mobile-menu", "out/surfaces.json"),
      },
    },
    build: "node examples/mobile-menu/pipeline.mjs",
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
    tree: (slug: string) => join(process.cwd(), `../../packages/dsl/fixtures/${slug}.json`),
    data: (slug: string) => join(process.cwd(), `../../packages/renderer/fixtures/${slug}.data.json`),
    surfaces: () => SURFACES,
  },
  compiled: {
    label: "@fanos/compile",
    tree: (slug: string) => join(process.cwd(), `../../packages/compile/out/${slug}.json`),
    data: () => undefined,
    surfaces: () => join(process.cwd(), "../../packages/compile/out/surfaces.json"),
  },
  /**
   * The hybrid pipeline's output: compiled, then repaired, then gated.
   *
   * This is the third point of the comparison and the interesting one. `hand` is
   * what a person writes, `compiled` is what determinism alone can prove, and
   * this is what the two halves produce together — the compiler's structure with
   * the model's bindings, sources and intent on top.
   *
   * Built by `node examples/news-section/pipeline.mjs`.
   */
  repaired: {
    label: "compile + repair",
    tree: (slug: string) => join(process.cwd(), `../../examples/${slug}/out/2b-section.dsl.json`),
    data: (slug: string) => join(process.cwd(), `../../examples/${slug}/data.json`),
    surfaces: (slug: string) => join(process.cwd(), `../../examples/${slug}/out/surfaces.json`),
  },
} as const;

function example(dir: string, file: string): string {
  return join(process.cwd(), "../../examples", dir, file);
}

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
  const from =
    params.from === "compiled" || params.from === "repaired" ? params.from : "hand";
  const source = SOURCES[from];
  const width = Number(params.width ?? card.designWidth ?? 564);

  /**
   * A card may point a source somewhere other than the shared fixture dirs.
   * Everything below reads through this, and every read is guarded — a harness
   * that 500s because one artifact has not been generated yet is worse than one
   * that says which command generates it.
   */
  const override = (card as { paths?: Record<string, { tree?: string; data?: string; surfaces?: string }> })
    .paths?.[from];
  const treePath = override?.tree ?? source.tree(card.slug);
  const dataPath = override ? override.data : source.data(card.slug);
  const surfacesPath = override?.surfaces ?? source.surfaces(card.slug);
  const buildHint = (card as { build?: string }).build;

  /** Only the sources this card really has. A tab that 500s is not a tab. */
  const available = ((card as { only?: readonly string[] }).only ??
    (Object.keys(SOURCES) as Array<keyof typeof SOURCES>)) as Array<keyof typeof SOURCES>;

  /**
   * What to tell someone looking at an empty page.
   *
   * Per SOURCE, not per card. A frame that was never hand-authored cannot be
   * produced by any build command, and printing one would send somebody to run
   * a pipeline that will never create the file they are missing.
   */
  const guidance = !available.includes(from)
    ? `\nThere is no ${SOURCES[from].label} tree for this frame, and no command makes one — ` +
      `it was never written by hand. That absence is the point of this example: ` +
      `open the ${available.map((v) => SOURCES[v].label).join(" or ")} tab instead.`
    : `\nbuild it with:\n  ${
        buildHint ??
        "pnpm --filter @fanos/compile build && node packages/compile/dist/bin.js build --ir … --theme …"
      }`;

  let tree;
  const missing: string[] = [];
  try {
    tree = flatTreeSchema.parse(JSON.parse(readFileSync(treePath, "utf8")));
  } catch {
    missing.push(treePath);
  }

  let data: Record<string, unknown> | undefined;
  if (dataPath) {
    try {
      data = JSON.parse(readFileSync(dataPath, "utf8")) as Record<string, unknown>;
    } catch {
      // A tree with literal content needs no data; one with bindings will show
      // its braces, which is a truthful symptom rather than a crash.
      missing.push(dataPath);
    }
  }

  let surfaces;
  try {
    surfaces = loadSurfaces(surfacesPath);
  } catch {
    missing.push(surfacesPath);
  }

  const { css } = emitCss(loadTheme(THEME), {
    ...(surfaces ? { surfaces } : {}),
    // Surface textures resolve under /local/... which lives in public/
    assets: NEXT_ASSETS,
    scope: "root",
  });

  const tab = (value: keyof typeof SOURCES) => (
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
        {available.map((value) => tab(value))}
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
          <pre
            style={{
              color: "#e10a15",
              fontFamily: "ui-monospace, monospace",
              fontSize: 12,
              lineHeight: 1.7,
              maxWidth: 900,
              whiteSpace: "pre-wrap",
            }}
          >
            {`Nothing to render for "${card.slug}" from ${SOURCES[from].label}.`}
            {"\n\nnot found:\n"}
            {missing.map((path) => `  ${path.replace(process.cwd(), ".")}\n`).join("")}
            {guidance}
          </pre>
        )}
      </div>
    </>
  );
}
