// Server-only database access. Every user-facing read/write goes through
// withUser(), which runs as Postgres role `authenticated` with the user's id in
// the JWT claims, so Row Level Security is enforced exactly as on Supabase.
// privilegedQuery() bypasses RLS and is used ONLY for: looking up the signed-in
// user's own profile (email column is not granted to clients) and the
// clearly-labelled dev sign-in bypass.
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { asUser } from "./dbTx";
import { getConfig } from "./config";

const globalForDb = globalThis as unknown as { lernePool?: Pool };

function getPool(): Pool {
  if (!globalForDb.lernePool) {
    globalForDb.lernePool = new Pool({ connectionString: getConfig().DATABASE_URL, max: 10 });
  }
  return globalForDb.lernePool;
}

export function withUser<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return asUser(getPool(), userId, fn);
}

export async function privilegedQuery<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await getPool().query<T>(sql, params);
  return result.rows;
}

export async function rows<T extends QueryResultRow>(client: PoolClient, sql: string, params: unknown[] = []) {
  const result = await client.query<T>(sql, params);
  return result.rows;
}
