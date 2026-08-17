/**
 * Environment, parsed once at boot and never read from `process.env` again.
 * A missing or malformed variable kills the process here rather than surfacing
 * as an undefined halfway through a pipeline run.
 */
import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  REDIS_URL: z.string().url(),

  /**
   * Electric's HTTP sync endpoint. Never reachable from a browser: it knows
   * nothing about API keys or tenants, so every request is proxied through
   * this service, which scopes the shape before forwarding.
   */
  ELECTRIC_URL: z.string().url().default("http://localhost:3010"),

  /** Where artifact blobs land. `fs` is the only driver today; see artifacts/store.ts. */
  BLOB_DRIVER: z.enum(["fs"]).default("fs"),
  BLOB_ROOT: z.string().default("./.blobs"),

  /** Comma-separated API keys. Empty disables auth — only allowed outside production. */
  API_KEYS: z.string().default(""),

  /** Comma-separated browser origins allowed to call this API. Empty = none. */
  CORS_ORIGINS: z.string().default("http://localhost:3415"),

  /** Worker concurrency per process. Pipeline steps are CPU-bound, so keep it near core count. */
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /** Attempts per run, including the first. */
  RUN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),

  /**
   * The geometry gate (C2): render each compiled tree headlessly and compare
   * every node's box against the IR.
   *
   * On by default. It is the only check that can see a layout error — coverage
   * checks confirm a node exists, not that it is the right size — and turning
   * it off returns the gate to reporting `compared: 0`, which reads like a pass
   * and is not one. Off is for environments with no chromium.
   */
  GEOMETRY_GATE: z.enum(["on", "off"]).default("on"),
  /** Absolute path to the renderer CLI. Resolved from the package when unset. */
  GEOMETRY_CLI_PATH: z.string().optional(),
  /** A hung browser must not hold a run open. */
  GEOMETRY_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  /**
   * How a marked background becomes a URL the renderer can fetch.
   *
   *   data-uri     inline the bytes into the surface set (default). The run is
   *                self-contained, so a preview, the pixel harness and an
   *                offline reader all paint without reaching this service.
   *   artifact-url point at the artifact content endpoint. Small artifacts,
   *                but the renderer must be able to reach and authenticate
   *                against the API — Surface Studio proxies it for the board.
   *   s3           object storage. Production; not implemented yet.
   *
   * There is deliberately no "fall back to a default image" mode. An asset that
   * cannot be resolved is reported on the run and renders as nothing, because a
   * background that renders as the WRONG picture is a bug that ships.
   */
  ASSET_PUBLISHER: z.enum(["data-uri", "artifact-url", "s3"]).default("data-uri"),
  /** Origin the renderer reaches artifact content on, for `artifact-url`. */
  ASSET_BASE_URL: z.string().url().default("http://localhost:3000"),
  /** Per-asset ceiling on the base64 payload, for `data-uri`. */
  ASSET_MAX_BYTES: z.coerce.number().int().positive().default(4 * 1024 * 1024),
});

export type Config = Readonly<
  Omit<z.infer<typeof Env>, "API_KEYS" | "CORS_ORIGINS"> & {
    apiKeys: ReadonlySet<string>;
    corsOrigins: ReadonlySet<string>;
    isProduction: boolean;
  }
>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }

  const { API_KEYS, CORS_ORIGINS, ...rest } = parsed.data;
  const split = (value: string): Set<string> =>
    new Set(
      value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    );

  const apiKeys = split(API_KEYS);
  const corsOrigins = split(CORS_ORIGINS);

  const isProduction = rest.NODE_ENV === "production";
  if (isProduction && apiKeys.size === 0) {
    throw new Error("API_KEYS must be set in production");
  }

  return Object.freeze({ ...rest, apiKeys, corsOrigins, isProduction });
}
