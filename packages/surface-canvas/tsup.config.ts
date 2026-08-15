/**
 * Library build, separate from the Figma plugin bundles in `esbuild.mjs`.
 *
 * The plugin ships as IIFE for the Figma sandbox; this ships the two pure
 * halves as ES modules for Node consumers:
 *
 *   ./ir      the Frame IR schema        (@fanos/conform, @fanos/compile)
 *   ./health  the lint rules + matchers  (the CI handoff gate, later)
 *
 * `src/health/**` and `src/match/**` were written with no Figma import for
 * exactly this reason — see tests/purity.test.ts, which enforces it.
 */
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "ir/index": "src/ir/index.ts", "health/index": "src/health/index.ts" },
  format: ["esm"],
  dts: true,
  // esbuild.mjs writes code.js / ui.html into the same dist — never wipe them.
  clean: false,
  sourcemap: true,
  target: "node22",
  external: ["zod", "@fanos/tokens"],
});
