// RLS, session-token and rating rules, enforced inside Postgres.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { asUser } from "@/lib/dbTx";
import {
  assignAndAccept, createRequest, createTestDb, createUser, issueToken, makeTutor, q, redeem, runSession,
  type TestDb,
} from "./harness";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb("lerne_test_security");
});

afterAll(async () => {
  await db?.close();
});

describe("row level security", () => {
  test("RLS is enabled on every table in the public schema", async () => {
    const { rows } = await db.pool.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  test("signed-in users cannot write to the ledger directly", async () => {
    const user = await createUser(db.pool, "forger");
    await expect(
      asUser(db.pool, user, (c) =>
        c.query("insert into credit_ledger (user_id, delta, reason) values (auth.uid(), 50, 'demo_adjustment')"),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  test("users see only their own ledger rows and requests", async () => {
    const alice = await createUser(db.pool, "alice");
    const bob = await createUser(db.pool, "bob");
    await createRequest(db.pool, bob, 1);
    const seen = await asUser(db.pool, alice, async (c) => ({
      ledger: await q(c, "select user_id from credit_ledger"),
      requests: await q(c, "select id from help_requests"),
    }));
    expect(seen.ledger.every((r) => r.user_id === alice)).toBe(true);
    expect(seen.requests).toEqual([]);
  });

  test("email addresses of other users are not readable", async () => {
    const user = await createUser(db.pool, "curious");
    await expect(asUser(db.pool, user, (c) => c.query("select email from profiles"))).rejects.toThrow(
      /permission denied/,
    );
    const names = await asUser(db.pool, user, (c) => q(c, "select display_name from profiles limit 1"));
    expect(names.length).toBe(1);
  });

  test("users cannot add courses or slots for someone else", async () => {
    const me = await createUser(db.pool, "me");
    const other = await createUser(db.pool, "other");
    await expect(
      asUser(db.pool, me, (c) =>
        c.query("insert into tutor_courses (user_id, course_code) values ($1, 'TK1-01')", [other]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  test("internal helpers are not callable by signed-in users", async () => {
    const user = await createUser(db.pool, "prober");
    await expect(asUser(db.pool, user, (c) => c.query("select balance_of($1)", [user]))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asUser(db.pool, user, (c) => c.query("select _sign_session_token(gen_random_uuid(), 'end', 9999999999)")),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("campus email restriction", () => {
  test("non @ui.ac.id sign-ups are rejected by the database", async () => {
    await expect(db.pool.query("insert into auth.users (email) values ('someone@gmail.com')")).rejects.toThrow(
      /EMAIL_DOMAIN/,
    );
    await expect(db.pool.query("insert into auth.users (email) values ('x@fakeui.ac.id.evil.com')")).rejects.toThrow(
      /EMAIL_DOMAIN/,
    );
  });
});

describe("session QR tokens", () => {
  async function scheduledSession() {
    const tutor = await createUser(db.pool, "qrTutor");
    const learner = await createUser(db.pool, "qrLearner");
    await makeTutor(db.pool, tutor);
    const requestId = await createRequest(db.pool, learner, 1);
    const sessionId = await assignAndAccept(db.pool, requestId, learner, tutor);
    return { tutor, learner, sessionId };
  }

  test("only the session's tutor can issue a token", async () => {
    const { learner, sessionId } = await scheduledSession();
    await expect(issueToken(db.pool, learner, sessionId, "start")).rejects.toThrow(/NOT_FOUND/);
  });

  test("a tampered token is rejected", async () => {
    const { tutor, learner, sessionId } = await scheduledSession();
    const token = await issueToken(db.pool, tutor, sessionId, "start");
    const parts = token.split(".");
    const tampered = [parts[0], parts[1], String(Number(parts[2]) + 3600), parts[3]].join(".");
    await expect(redeem(db.pool, learner, tampered)).rejects.toThrow(/INVALID_TOKEN/);
  });

  test("an expired token is rejected", async () => {
    const { learner, sessionId } = await scheduledSession();
    const past = Math.floor(Date.now() / 1000) - 5;
    const { rows } = await db.pool.query("select _sign_session_token($1, 'start', $2) as t", [sessionId, past]);
    await expect(redeem(db.pool, learner, rows[0].t)).rejects.toThrow(/TOKEN_EXPIRED/);
  });

  test("a token cannot be redeemed by anyone except the session's learner", async () => {
    const { tutor, sessionId } = await scheduledSession();
    const stranger = await createUser(db.pool, "stranger");
    const token = await issueToken(db.pool, tutor, sessionId, "start");
    await expect(redeem(db.pool, stranger, token)).rejects.toThrow(/NOT_FOUND/);
    await expect(redeem(db.pool, tutor, token)).rejects.toThrow(/NOT_FOUND/);
  });

  test("an end token cannot end a session that has not started; start cannot be replayed", async () => {
    const { tutor, learner, sessionId } = await scheduledSession();
    const future = Math.floor(Date.now() / 1000) + 60;
    const { rows } = await db.pool.query("select _sign_session_token($1, 'end', $2) as t", [sessionId, future]);
    await expect(redeem(db.pool, learner, rows[0].t)).rejects.toThrow(/INVALID_STATE/);

    const start = await issueToken(db.pool, tutor, sessionId, "start");
    expect(await redeem(db.pool, learner, start)).toBe("in_progress");
    await expect(redeem(db.pool, learner, start)).rejects.toThrow(/INVALID_STATE/);
  });
});

describe("ratings", () => {
  test("both sides can rate once after completion, and ratings feed match_candidates", async () => {
    const tutor = await createUser(db.pool, "rTutor");
    const learner = await createUser(db.pool, "rLearner");
    await makeTutor(db.pool, tutor);
    const sessionId = await runSession(db.pool, learner, tutor, 1);

    await asUser(db.pool, learner, (c) => c.query("select rate_session($1, 4)", [sessionId]));
    await asUser(db.pool, tutor, (c) => c.query("select rate_session($1, 5)", [sessionId]));
    await expect(
      asUser(db.pool, learner, (c) => c.query("select rate_session($1, 1)", [sessionId])),
    ).rejects.toThrow(/ALREADY_RATED/);

    const next = await createRequest(db.pool, learner, 1);
    const candidates = await asUser(db.pool, learner, (c) =>
      q<{ tutor_id: string; rating_avg: string; rating_count: number }>(c, "select * from match_candidates($1)", [next]),
    );
    const me = candidates.find((r) => r.tutor_id === tutor);
    expect(Number(me?.rating_avg)).toBe(4);
    expect(me?.rating_count).toBe(1);
  });

  test("ratings are rejected before completion, out of range, or from non-participants", async () => {
    const tutor = await createUser(db.pool, "r2Tutor");
    const learner = await createUser(db.pool, "r2Learner");
    const outsider = await createUser(db.pool, "r2Outsider");
    await makeTutor(db.pool, tutor);
    const requestId = await createRequest(db.pool, learner, 1);
    const sessionId = await assignAndAccept(db.pool, requestId, learner, tutor);

    const rate = (user: string, score: number) =>
      asUser(db.pool, user, (c) => c.query("select rate_session($1, $2)", [sessionId, score]));

    await expect(rate(learner, 5)).rejects.toThrow(/INVALID_STATE/);
    await redeem(db.pool, learner, await issueToken(db.pool, tutor, sessionId, "start"));
    await redeem(db.pool, learner, await issueToken(db.pool, tutor, sessionId, "end"));
    await expect(rate(learner, 6)).rejects.toThrow(/INVALID_INPUT/);
    await expect(rate(outsider, 3)).rejects.toThrow(/NOT_FOUND/);
  });
});

describe("request lifecycle", () => {
  test("a declined tutor is excluded and the request reopens", async () => {
    const tutor = await createUser(db.pool, "dTutor");
    const learner = await createUser(db.pool, "dLearner");
    await makeTutor(db.pool, tutor);
    const requestId = await createRequest(db.pool, learner, 1);
    await asUser(db.pool, learner, (c) => c.query("select assign_tutor($1, $2)", [requestId, tutor]));
    await asUser(db.pool, tutor, (c) => c.query("select respond_to_request($1, false)", [requestId]));

    const { rows } = await db.pool.query("select status, tutor_id from help_requests where id = $1", [requestId]);
    expect(rows[0]).toEqual({ status: "open", tutor_id: null });
    const candidates = await asUser(db.pool, learner, (c) =>
      q<{ tutor_id: string; declined: boolean }>(c, "select tutor_id, declined from match_candidates($1)", [requestId]),
    );
    expect(candidates.find((r) => r.tutor_id === tutor)?.declined).toBe(true);
    await expect(
      asUser(db.pool, learner, (c) => c.query("select assign_tutor($1, $2)", [requestId, tutor])),
    ).rejects.toThrow(/already declined/);
  });
});
