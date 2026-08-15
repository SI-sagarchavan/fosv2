import { defineConfig } from "tsup";

const external = ["zod", "@fanos/tokens", "@fanos/dsl", "@fanos/conform", "@fanos/surface-canvas"];

export default defineConfig([
  { entry: ["src/index.ts"], format: ["esm"], dts: true, clean: true, sourcemap: true, target: "node22", external },
  { entry: ["src/bin.ts"], format: ["esm"], dts: false, clean: false, sourcemap: true, target: "node22", external },
]);
