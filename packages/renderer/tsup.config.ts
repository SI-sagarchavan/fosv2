import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node22",
    external: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "next",
      "next/image",
      "next/font/local",
      "@fanos/dsl",
      "@fanos/tokens",
      "playwright",
      "pixelmatch",
      "pngjs",
      "zod",
    ],
    esbuildOptions(options) {
      options.jsx = "automatic";
    },
  },
  {
    entry: ["src/bin.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
    target: "node22",
    external: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "next",
      "next/image",
      "@fanos/dsl",
      "@fanos/tokens",
      "playwright",
      "pixelmatch",
      "pngjs",
      "zod",
    ],
    // Without this, esbuild emits React.createElement with no React import
    // and `fos-render png` dies with "React is not defined".
    esbuildOptions(options) {
      options.jsx = "automatic";
    },
  },
]);
