import { defineConfig } from "tsup";

const external = [
  "bullmq",
  "drizzle-orm",
  "fastify",
  "ioredis",
  "postgres",
  "zod",
  "@fanos/compile",
  "@fanos/conform",
  "@fanos/dsl",
  "@fanos/surface-canvas",
  "@fanos/tokens",
];

export default defineConfig({
  // Three entries: the HTTP process, the worker process, and the migrator.
  // They share the whole src tree, so tsup keeps the directory layout rather
  // than collapsing to a single bundle — `dist/platform/db/migrate.js` has to
  // stay addressable from package.json scripts.
  entry: ["src/index.ts", "src/worker.ts", "src/platform/db/migrate.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node22",
  bundle: true,
  splitting: false,
  external,
});
