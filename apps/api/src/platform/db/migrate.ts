/**
 * Standalone migrator, run as its own process before the API starts.
 * Deliberately not wired into server boot: two replicas racing to migrate on
 * deploy is a worse failure than one explicit step in the release.
 */
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { loadConfig } from "../../config.js";
import { createDb } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig();
  const { db, close } = createDb(config);
  try {
    await migrate(db, { migrationsFolder: resolve(here, "../../../drizzle") });
    console.log("migrations applied");
  } finally {
    await close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
