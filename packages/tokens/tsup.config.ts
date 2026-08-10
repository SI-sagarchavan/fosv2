import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node22",
    // zod is the only runtime dep and stays external — consumers dedupe it.
    external: ["zod"],
  },
  {
    entry: ["src/bin.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
    target: "node22",
    external: ["zod"],
    // No `banner` here — esbuild already carries the shebang over from
    // src/bin.ts, and adding one emits it twice, which is a syntax error.
  },
]);
