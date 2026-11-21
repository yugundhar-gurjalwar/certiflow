import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Applies pending migrations. Safe to run from several containers at once: Postgres advisory lock
 * serialises them, and drizzle records applied migrations in its own table.
 */
export async function runMigrations(): Promise<void> {
  const folder = path.resolve(here, process.env.MIGRATIONS_DIR ?? "../../drizzle");
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(727274)");
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await client.query("select pg_advisory_unlock(727274)").catch(() => {});
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigrations()
    .then(() => { console.log("migrations applied"); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
