/**
 * One pool per process. Handed to modules as a `Db` rather than imported by
 * them directly, so tests can pass a transaction-scoped handle and get
 * rollback isolation for free.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { Config } from "../../config.js";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

export function createDb(config: Pick<Config, "DATABASE_URL" | "DATABASE_POOL_MAX">): DbHandle {
  const sql = postgres(config.DATABASE_URL, {
    max: config.DATABASE_POOL_MAX,
    // Prepared statements interact badly with connection poolers in front of
    // Postgres; off by default costs little at this scale.
    prepare: false,
  });

  return {
    db: drizzle(sql, { schema }),
    close: () => sql.end({ timeout: 5 }),
  };
}

export { schema };
