import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Integration tests need Postgres and live behind `pnpm test:integration`,
    // so the default suite stays runnable with nothing installed.
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**"],
  },
});
