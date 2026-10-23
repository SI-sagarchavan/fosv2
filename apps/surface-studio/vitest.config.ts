import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The compiler and renderer are read from their built `dist/`, and the first
    // render pulls in React's server build.
    testTimeout: 30_000,
  },
});
