import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node22",
    external: ["zod", "@fanos/tokens"],
  },
  {
    entry: ["src/bin.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
    target: "node22",
    external: ["zod", "@fanos/tokens"],
  },
]);
