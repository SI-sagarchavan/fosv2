/**
 * Two bundles:
 *   src/code.ts -> dist/code.js   (Figma sandbox, plain script)
 *   src/ui.ts   -> dist/ui.html   (inlined into the HTML shell; Figma only
 *                                  accepts a single self-contained UI file)
 */
import { build, context } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, "dist");
const watch = process.argv.includes("--watch");
const dev = watch || process.argv.includes("--dev");

const UI_PLACEHOLDER = "/* __UI_BUNDLE__ */";

const shared = {
  bundle: true,
  target: "es2017",
  logLevel: "info",
  sourcemap: dev ? "inline" : false,
  minify: !dev,
};

/** Bundles ui.ts and splices it into the <script> tag in ui.html. */
const inlineUiPlugin = {
  name: "inline-ui",
  setup(pluginBuild) {
    pluginBuild.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      const js = result.outputFiles?.[0]?.text ?? "";
      const shell = await readFile(resolve(root, "src/ui.html"), "utf8");
      if (!shell.includes(UI_PLACEHOLDER)) {
        throw new Error(`src/ui.html is missing the ${UI_PLACEHOLDER} marker`);
      }
      await mkdir(dist, { recursive: true });
      await writeFile(resolve(dist, "ui.html"), shell.replace(UI_PLACEHOLDER, js));
      console.log("  dist/ui.html");
    });
  },
};

const codeConfig = {
  ...shared,
  entryPoints: [resolve(root, "src/code.ts")],
  outfile: resolve(dist, "code.js"),
  format: "iife",
};

const uiConfig = {
  ...shared,
  entryPoints: [resolve(root, "src/ui.ts")],
  format: "iife",
  write: false,
  outfile: resolve(dist, "ui.js"),
  plugins: [inlineUiPlugin],
};

if (watch) {
  const contexts = await Promise.all([context(codeConfig), context(uiConfig)]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("watching…");
} else {
  await Promise.all([build(codeConfig), build(uiConfig)]);
}
