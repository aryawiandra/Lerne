// Node-side helpers to build a local Lerne database from the SQL files in this
// repo. Used by scripts/dbSetup.ts (local fallback) and the DB test suites.
import { Client } from "pg";
import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(__dirname, "..");
export const SHIM_FILE = path.join(ROOT, "db/local/00_supabase_shim.sql");
export const COURSES_FILE = path.join(ROOT, "supabase/seed/courses.sql");
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");

export function migrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => path.join(MIGRATIONS_DIR, f));
}

/** Same server/credentials as `url`, different database name. */
export function databaseUrlFor(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

const SAFE_DB_NAME = /^[a-z][a-z0-9_]{2,62}$/;

export async function recreateDatabase(baseUrl: string, dbName: string): Promise<string> {
  if (!SAFE_DB_NAME.test(dbName)) throw new Error(`Refusing unsafe database name: ${dbName}`);
  const admin = new Client({ connectionString: databaseUrlFor(baseUrl, "postgres") });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${dbName} with (force)`);
    await admin.query(`create database ${dbName}`);
  } finally {
    await admin.end();
  }
  return databaseUrlFor(baseUrl, dbName);
}

export async function applySqlFiles(url: string, files: readonly string[]): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const file of files) {
      try {
        await client.query(fs.readFileSync(file, "utf8"));
      } catch (error) {
        throw new Error(`Failed applying ${path.relative(ROOT, file)}: ${(error as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

/** Shim + migrations + course catalogue: a complete local database. */
export function localSchemaFiles(): string[] {
  return [SHIM_FILE, ...migrationFiles(), COURSES_FILE];
}
