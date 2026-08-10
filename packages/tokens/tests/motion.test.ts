import { describe, expect, it } from "vitest";
import {
  createRegistry,
  DEFAULT_REDUCED_MOTION_POLICY,
  DURATION_SCALE,
  EASING_SCALE,
  emitCss,
  emitTypes,
  LOCAL_ASSET_CONTEXT,
  resolveAsset,
} from "../src/index.js";
import { loadSurfaces, loadTheme } from "../src/load.js";

const FIXTURE = new URL("../fixtures/southern-brave.json", import.meta.url).pathname;
const SURFACES = new URL("../surfaces/southern-brave.json", import.meta.url).pathname;

describe("motion scale", () => {
  it("exposes the five duration steps in ms", () => {
    expect(DURATION_SCALE).toEqual({
      instant: 0,
      fast: 120,
      base: 200,
      slow: 320,
      deliberate: 500,
    });
  });

  it("registers duration and easing on every theme", () => {
    const r = createRegistry(loadTheme(FIXTURE));
    expect(r.has("duration.fast")).toBe(true);
    expect(r.has("duration.nope")).toBe(false);
    expect(r.resolve("duration.base")).toEqual({ category: "duration", ms: 200 });
    expect(r.resolve("easing.standard")?.category).toBe("easing");
    expect(r.resolve("motion.reducedPolicy")).toEqual({
      category: "motion",
      policy: DEFAULT_REDUCED_MOTION_POLICY,
    });
    expect(r.list("duration")).toEqual([
      "duration.base",
      "duration.deliberate",
      "duration.fast",
      "duration.instant",
      "duration.slow",
    ]);
  });

  it("emits --fos-duration-* and --fos-easing-* vars", () => {
    const { css } = emitCss(loadTheme(FIXTURE));
    expect(css).toContain("--fos-duration-instant: 0ms;");
    expect(css).toContain("--fos-duration-fast: 120ms;");
    expect(css).toContain("--fos-duration-base: 200ms;");
    expect(css).toContain("--fos-duration-slow: 320ms;");
    expect(css).toContain("--fos-duration-deliberate: 500ms;");
    expect(css).toContain("--fos-easing-standard:");
    expect(css).toContain("--fos-easing-enter:");
    expect(css).toContain("--fos-easing-exit:");
    expect(css).toContain("--fos-easing-spring:");
    // Leaf is camelCase (`reducedPolicy`); dashify only rewrites underscores.
    expect(css).toContain(`--fos-motion-reducedPolicy: ${DEFAULT_REDUCED_MOTION_POLICY};`);
    for (const curve of Object.values(EASING_SCALE)) {
      expect(css).toContain(curve);
    }
  });

  it("emits DurationToken and EasingToken unions", () => {
    const out = emitTypes(loadTheme(FIXTURE), { surfaces: loadSurfaces(SURFACES) });
    expect(out).toContain("export type DurationToken =");
    expect(out).toContain('"duration.fast"');
    expect(out).toContain("export type EasingToken =");
    expect(out).toContain('"easing.spring"');
    expect(out).toContain("export type MotionToken =");
  });
});

describe("resolveAsset", () => {
  it("maps asset.texture.stripes through cdn + tenant", () => {
    expect(
      resolveAsset("asset.texture.stripes", {
        cdnBase: "https://cdn.example",
        tenant: "southern-brave",
      }),
    ).toBe("https://cdn.example/southern-brave/textures/stripes.png");
  });

  it("includes an optional version segment", () => {
    expect(
      resolveAsset("asset.texture.noise", {
        cdnBase: "https://cdn.example",
        tenant: "sb",
        version: "v3",
      }),
    ).toBe("https://cdn.example/sb/v3/textures/noise.png");
  });

  it("uses the local-dev context under /public", () => {
    expect(resolveAsset("asset.texture.stripes", LOCAL_ASSET_CONTEXT)).toBe(
      "/public/local/textures/stripes.png",
    );
  });

  it("pluralises the kind segment", () => {
    expect(
      resolveAsset("asset.silhouette.player", { cdnBase: "/public", tenant: "local" }),
    ).toBe("/public/local/silhouettes/player.png");
  });

  it("rejects non-asset refs", () => {
    expect(() => resolveAsset("color.core_sec_500", LOCAL_ASSET_CONTEXT)).toThrow(/asset\.\*/);
  });

  it("resolves surface image layers when assets context is passed to emitCss", () => {
    // Derived from the surfaces file, not hardcoded: which textures a surface
    // layers is a design value that changes, while "every asset.* image layer
    // resolves through the CDN context" is the behaviour under test.
    const surfaces = loadSurfaces(SURFACES);
    const { css } = emitCss(loadTheme(FIXTURE), {
      surfaces,
      assets: { cdnBase: "https://cdn.example", tenant: "sb" },
    });
    const imageRefs = [...surfaces.surfaces.values()]
      .flatMap((s) => s.layers ?? [])
      .filter((l) => l.type === "image")
      .map((l) => l.ref);
    expect(imageRefs.length).toBeGreaterThan(0);
    for (const ref of imageRefs) {
      const url = resolveAsset(ref, { cdnBase: "https://cdn.example", tenant: "sb" });
      expect(url).toMatch(/^https:\/\/cdn\.example\/sb\//);
      expect(css, ref).toContain(`url("${url}")`);
    }
  });
});
