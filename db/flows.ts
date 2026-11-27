// Drives the real SQL API as specific users (via asUser → RLS applies).
// Shared by the seed script and the database tests so both exercise exactly
// the same functions the web app calls.
import type { Pool, PoolClient } from "pg";
import { asUser } from "../src/lib/dbTx";

export const DEFAULT_COURSE = "TK3-01";

function q<T>(client: PoolClient, sql: string, params: unknown[] = []): Promise<T[]> {
  return client.query(sql, params).then((r) => r.rows as T[]);
}

/** Creates a SYNTHETIC user the way Supabase Auth would (a row in auth.users). */
export async function createUser(pool: Pool, email: string, displayName: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id",
    [email, { display_name: displayName, is_synthetic: true }],
  );
  return rows[0].id;
}

export async function makeTutor(pool: Pool, tutorId: string, courses: readonly string[] = [DEFAULT_COURSE]) {
  await asUser(pool, tutorId, (c) =>
    c.query("insert into tutor_courses (user_id, course_code) select auth.uid(), unnest($1::text[])", [courses]),
  );
}

/** The tutor raises (or lowers) their own weekly session limit (1-10; default 2). */
export async function setWeeklyLimit(pool: Pool, tutorId: string, limit: number) {
  await asUser(pool, tutorId, (c) => c.query("select set_weekly_session_limit($1)", [limit]));
}

export async function addSlot(pool: Pool, userId: string, dayOfWeek: number, startMinute: number, endMinute: number) {
  await asUser(pool, userId, (c) =>
    c.query(
      "insert into availability_slots (user_id, day_of_week, start_minute, end_minute) values (auth.uid(), $1, $2, $3)",
      [dayOfWeek, startMinute, endMinute],
    ),
  );
}

export async function createRequest(
  pool: Pool,
  learnerId: string,
  hours = 1,
  course = DEFAULT_COURSE,
  topic = "Linked lists and recursion",
): Promise<string> {
  return asUser(pool, learnerId, async (c) => {
    const [row] = await q<{ id: string }>(
      c,
      "select create_help_request($1, $2, now() + interval '1 day', $3) as id",
      [course, topic, hours],
    );
    return row.id;
  });
}

export async function assignAndAccept(pool: Pool, requestId: string, learnerId: string, tutorId: string) {
  await asUser(pool, learnerId, (c) => c.query("select assign_tutor($1, $2)", [requestId, tutorId]));
  return asUser(pool, tutorId, async (c) => {
    const [row] = await q<{ id: string }>(c, "select respond_to_request($1, true) as id", [requestId]);
    return row.id;
  });
}

export async function issueToken(pool: Pool, tutorId: string, sessionId: string, phase: "start" | "end") {
  return asUser(pool, tutorId, async (c) => {
    const [row] = await q<{ token: string }>(c, "select token from issue_session_token($1, $2)", [sessionId, phase]);
    return row.token;
  });
}

export async function redeem(pool: Pool, learnerId: string, token: string): Promise<string> {
  return asUser(pool, learnerId, async (c) => {
    const [row] = await q<{ status: string }>(c, "select redeem_session_token($1) as status", [token]);
    return row.status;
  });
}

/** Full happy path: request → accept → start QR → end QR. Returns session id. */
export async function runSession(
  pool: Pool,
  learnerId: string,
  tutorId: string,
  hours = 1,
  course = DEFAULT_COURSE,
  topic?: string,
): Promise<string> {
  const requestId = await createRequest(pool, learnerId, hours, course, topic);
  const sessionId = await assignAndAccept(pool, requestId, learnerId, tutorId);
  await redeem(pool, learnerId, await issueToken(pool, tutorId, sessionId, "start"));
  await redeem(pool, learnerId, await issueToken(pool, tutorId, sessionId, "end"));
  return sessionId;
}

export async function rate(pool: Pool, userId: string, sessionId: string, score: number) {
  await asUser(pool, userId, (c) => c.query("select rate_session($1, $2)", [sessionId, score]));
}

/** Privileged credit adjustment (reason demo_adjustment) — tests/seed only. */
export async function grant(pool: Pool, userId: string, credits: number): Promise<void> {
  await pool.query("insert into credit_ledger (user_id, delta, reason) values ($1, $2, 'demo_adjustment')", [
    userId,
    credits,
  ]);
}
