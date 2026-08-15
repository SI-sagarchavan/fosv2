import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // One database, shared. Parallel files would truncate each other's rows
    // mid-test, and the concurrency these tests check is inside a file anyway.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
