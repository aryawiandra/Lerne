// Test harness: builds a throwaway Postgres database from the repo's SQL and
// re-exports the shared flow helpers that drive the real SQL functions.
import { Pool, type PoolClient } from "pg";
import { applySqlFiles, localSchemaFiles, recreateDatabase } from "../../db/sql";
import { createUser as createNamedUser, makeTutor as makeTutorFor } from "../../db/flows";
import { asUser } from "@/lib/dbTx";

export {
  assignAndAccept, createRequest, DEFAULT_COURSE as COURSE, grant, issueToken, redeem, runSession,
} from "../../db/flows";

const BASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/postgres";

export interface TestDb {
  pool: Pool;
  close: () => Promise<void>;
}

export async function createTestDb(name: string): Promise<TestDb> {
  const url = await recreateDatabase(BASE_URL, name);
  await applySqlFiles(url, localSchemaFiles());
  const pool = new Pool({ connectionString: url, max: 4 });
  return { pool, close: () => pool.end() };
}

let counter = 0;

/** SYNTHETIC test user with a unique @ui.ac.id address. */
export function createUser(pool: Pool, label: string): Promise<string> {
  counter += 1;
  return createNamedUser(pool, `test.${label.toLowerCase()}.${counter}.${Date.now()}@ui.ac.id`, `Test ${label}`);
}

export function makeTutor(pool: Pool, tutorId: string): Promise<void> {
  return makeTutorFor(pool, tutorId);
}

export function q<T = Record<string, unknown>>(client: PoolClient, sql: string, params: unknown[] = []) {
  return client.query(sql, params).then((r) => r.rows as T[]);
}

export async function balance(pool: Pool, userId: string): Promise<number> {
  return asUser(pool, userId, async (c) => {
    const [row] = await q<{ balance: number }>(c, "select balance from my_credit_summary()");
    return row.balance;
  });
}
