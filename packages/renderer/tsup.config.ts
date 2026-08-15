import { defineConfig } from "tsup";

/**
 * Externals are shared across all three entries. `next` is gone — this package
 * no longer knows a framework exists; `apps/web` is the thing that does.
 */
const external = [
  "react",
  "react-dom",
  "react-dom/server",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@fanos/dsl",
  "@fanos/tokens",
  "playwright",
  "pixelmatch",
  "pngjs",
  "zod",
];

const jsx = (options: { jsx?: string }) => {
  options.jsx = "automatic";
};

export default defineConfig([
  {
    // The SDK. Nothing here reaches Playwright — that separation is the point
    // of the split, so keep this entry free of harness imports.
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node22",
    external,
    esbuildOptions: jsx,
  },
  {
    // The acceptance harness, behind `@fanos/renderer/harness`.
    entry: ["src/harness.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: true,
    target: "node22",
    external,
    esbuildOptions: jsx,
  },
  {
    // The `fos-render` CLI.
    entry: ["src/bin.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
    target: "node22",
    external,
    // Without this, esbuild emits React.createElement with no React import and
    // `fos-render png` dies with "React is not defined".
    esbuildOptions: jsx,
  },
]);
