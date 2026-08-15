/**
 * Real-Postgres harness.
 *
 * Everything here exists because in-memory fakes cannot lie convincingly about
 * concurrency. A fake `createVersion` allocates the next number correctly and
 * will happily pass a test that two real transactions would deadlock or
 * duplicate. These tests are the other half of that contract.
 */
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";

import { loadConfig, type Config } from "../../src/config.js";
import { createDb, type Db, type DbHandle } from "../../src/platform/db/client.js";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://fanos:fanos@localhost:5433/fanos";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function testConfig(): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL,
    REDIS_URL: "redis://localhost:6379",
    BLOB_ROOT: "./.blobs-test",
  });
}

export interface Harness {
  db: Db;
  handle: DbHandle;
  /** Wipes every table between tests. Cheap at this size, and unambiguous. */
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const config = testConfig();
  const handle = createDb(config);
  await migrate(handle.db, { migrationsFolder: MIGRATIONS });

  const reset = async () => {
    await handle.db.execute(sql`
      truncate table
        audit_log, fidelity_reports, run_steps, runs,
        surface_versions, surfaces, artifacts, projects
      restart identity cascade
    `);
  };

  await reset();

  return { db: handle.db, handle, reset, close: () => handle.close() };
}

/** Fails loudly rather than silently skipping — a green run must mean something. */
export async function requireDatabase(): Promise<void> {
  const handle = createDb(testConfig());
  try {
    await handle.db.execute(sql`select 1`);
  } catch (err) {
    throw new Error(
      `integration tests need Postgres at ${DATABASE_URL}\n` +
        `start it with: docker compose up -d\n` +
        `cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await handle.close();
  }
}
