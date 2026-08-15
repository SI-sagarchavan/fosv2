import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const BASE = {
  DATABASE_URL: "postgres://fanos:fanos@localhost:5432/fanos",
  REDIS_URL: "redis://localhost:6379",
};

describe("loadConfig", () => {
  it("fills defaults", () => {
    const config = loadConfig(BASE);
    expect(config.PORT).toBe(4000);
    expect(config.NODE_ENV).toBe("development");
    expect(config.RUN_MAX_ATTEMPTS).toBe(3);
  });

  it("refuses to boot without a database url", () => {
    expect(() => loadConfig({ REDIS_URL: BASE.REDIS_URL })).toThrow(/DATABASE_URL/);
  });

  it("coerces numeric strings, because env vars are always strings", () => {
    expect(loadConfig({ ...BASE, PORT: "8080" }).PORT).toBe(8080);
  });

  it("splits and trims API_KEYS", () => {
    const config = loadConfig({ ...BASE, API_KEYS: " one , two ,, three " });
    expect([...config.apiKeys].sort()).toEqual(["one", "three", "two"]);
  });

  it("allows an empty key set outside production", () => {
    expect(loadConfig({ ...BASE, NODE_ENV: "development" }).apiKeys.size).toBe(0);
  });

  it("refuses to boot production with no api keys", () => {
    expect(() => loadConfig({ ...BASE, NODE_ENV: "production" })).toThrow(/API_KEYS/);
  });

  it("boots production once keys are present", () => {
    const config = loadConfig({ ...BASE, NODE_ENV: "production", API_KEYS: "secret" });
    expect(config.isProduction).toBe(true);
    expect(config.apiKeys.has("secret")).toBe(true);
  });
});
