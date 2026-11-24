// LOCAL FALLBACK: (re)builds a local Postgres database for Lerne:
//   Supabase shim → migrations → course catalogue → SYNTHETIC demo seed.
// Usage: npm run db:setup   (reads DATABASE_URL from .env.local)
// Refuses to touch anything that is not on localhost.
import { Pool } from "pg";
import { applySqlFiles, localSchemaFiles, recreateDatabase } from "../db/sql";
import { seedDemoData } from "./seed";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", ""]);

export async function resetLocalDatabase(url: string): Promise<void> {
  const parsed = new URL(url);
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`db:setup only runs against a local database (got host "${parsed.hostname}").`);
  }
  const dbName = parsed.pathname.replace(/^\//, "");
  const target = await recreateDatabase(url, dbName);
  await applySqlFiles(target, localSchemaFiles());
  const pool = new Pool({ connectionString: target, max: 2 });
  try {
    await seedDemoData(pool);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local first.");
  await resetLocalDatabase(url);
  console.log(`Local database ready: ${new URL(url).pathname.slice(1)} (schema + SYNTHETIC demo data)`);
}

if (process.argv[1]?.endsWith("dbSetup.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
