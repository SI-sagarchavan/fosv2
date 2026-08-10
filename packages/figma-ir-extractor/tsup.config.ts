/**
 * Library build, separate from the Figma plugin bundles in `esbuild.mjs`.
 *
 * The plugin ships as IIFE for the Figma sandbox; this ships the IR schema as
 * an ES module for Node consumers (`@fanos/figma-ir-extractor/ir`).
 */
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "ir/index": "src/ir/index.ts" },
  format: ["esm"],
  dts: true,
  // esbuild.mjs writes code.js / ui.html into the same dist — never wipe them.
  clean: false,
  sourcemap: true,
  target: "node22",
  external: ["zod"],
});
