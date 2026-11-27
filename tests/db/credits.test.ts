// Credit rules, enforced inside Postgres (run against a real local database).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { asUser } from "@/lib/dbTx";
import {
  assignAndAccept, balance, createRequest, createTestDb, createUser, grant, issueToken,
  makeTutor, q, redeem, runSession, setWeeklyLimit, type TestDb,
} from "./harness";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb("lerne_test_credits");
});

afterAll(async () => {
  await db?.close();
});

describe("starting credits", () => {
  test("a new user starts with exactly 2 credits from a single signup_grant entry", async () => {
    // Arrange / Act
    const user = await createUser(db.pool, "newbie");
    // Assert
    expect(await balance(db.pool, user)).toBe(2);
    const rows = await asUser(db.pool, user, (c) => q(c, "select delta, reason from credit_ledger"));
    expect(rows).toEqual([{ delta: 2, reason: "signup_grant" }]);
  });
});

describe("settlement", () => {
  test("1 hour taught = +1 for tutor, 1 hour learned = -1 for learner", async () => {
    const tutor = await createUser(db.pool, "tutor");
    const learner = await createUser(db.pool, "learner");
    await makeTutor(db.pool, tutor);

    const sessionId = await runSession(db.pool, learner, tutor, 1);

    expect(await balance(db.pool, tutor)).toBe(3);
    expect(await balance(db.pool, learner)).toBe(1);
    const entries = await db.pool.query(
      "select user_id, delta, reason from credit_ledger where session_id = $1 order by id",
      [sessionId],
    );
    expect(entries.rows).toEqual([
      { user_id: learner, delta: -1, reason: "session_learned" },
      { user_id: tutor, delta: 1, reason: "session_taught" },
    ]);
  });

  test("a 2-hour session moves 2 credits", async () => {
    const tutor = await createUser(db.pool, "tutor2h");
    const learner = await createUser(db.pool, "learner2h");
    await makeTutor(db.pool, tutor);
    await runSession(db.pool, learner, tutor, 2);
    expect(await balance(db.pool, tutor)).toBe(4);
    expect(await balance(db.pool, learner)).toBe(0);
  });
});

describe("balance can never go negative", () => {
  test("requesting more hours than available credits is rejected by the database", async () => {
    const learner = await createUser(db.pool, "broke");
    await expect(createRequest(db.pool, learner, 3)).rejects.toThrow(/INSUFFICIENT_CREDITS/);
  });

  test("open requests reserve credits, so a learner cannot over-commit", async () => {
    const learner = await createUser(db.pool, "overcommit");
    await createRequest(db.pool, learner, 1);
    await createRequest(db.pool, learner, 1);
    await expect(createRequest(db.pool, learner, 1)).rejects.toThrow(/INSUFFICIENT_CREDITS/);
  });

  test("even a privileged direct ledger insert cannot push a balance below zero", async () => {
    const user = await createUser(db.pool, "direct");
    await expect(
      db.pool.query("insert into credit_ledger (user_id, delta, reason) values ($1, -3, 'demo_adjustment')", [user]),
    ).rejects.toThrow(/INSUFFICIENT_CREDITS/);
    expect(await balance(db.pool, user)).toBe(2);
  });

  test("if settlement would go negative, the whole end-of-session transaction rolls back", async () => {
    // Arrange: 2-hour session in progress, then the learner's balance drops to 1.
    const tutor = await createUser(db.pool, "tutorRollback");
    const learner = await createUser(db.pool, "learnerRollback");
    await makeTutor(db.pool, tutor);
    const requestId = await createRequest(db.pool, learner, 2);
    const sessionId = await assignAndAccept(db.pool, requestId, learner, tutor);
    await redeem(db.pool, learner, await issueToken(db.pool, tutor, sessionId, "start"));
    await grant(db.pool, learner, -1);

    // Act
    const endToken = await issueToken(db.pool, tutor, sessionId, "end");
    await expect(redeem(db.pool, learner, endToken)).rejects.toThrow(/INSUFFICIENT_CREDITS/);

    // Assert: nothing settled, session still in progress
    const { rows } = await db.pool.query("select status from tutoring_sessions where id = $1", [sessionId]);
    expect(rows[0].status).toBe("in_progress");
    expect(await balance(db.pool, tutor)).toBe(2);
    expect(await balance(db.pool, learner)).toBe(1);
  });
});

describe("weekly cap per tutor-learner pair (cap = 3)", () => {
  test("a 4th credit from the same learner in one week is blocked; another tutor is fine", async () => {
    const tutor = await createUser(db.pool, "capTutor");
    const otherTutor = await createUser(db.pool, "capOther");
    const learner = await createUser(db.pool, "capLearner");
    await makeTutor(db.pool, tutor);
    await makeTutor(db.pool, otherTutor);
    await setWeeklyLimit(db.pool, tutor, 5); // above the pair cap, so the pair cap is what blocks
    await grant(db.pool, learner, 10);

    for (let i = 0; i < 3; i += 1) await runSession(db.pool, learner, tutor, 1);
    expect(await balance(db.pool, tutor)).toBe(5);

    const fourth = await createRequest(db.pool, learner, 1);
    await expect(
      asUser(db.pool, learner, (c) => c.query("select assign_tutor($1, $2)", [fourth, tutor])),
    ).rejects.toThrow(/PAIR_WEEKLY_CAP/);

    await assignAndAccept(db.pool, fourth, learner, otherTutor);
  });

  test("accepted-but-unfinished sessions count toward the cap", async () => {
    const tutor = await createUser(db.pool, "capTutor2");
    const learner = await createUser(db.pool, "capLearner2");
    await makeTutor(db.pool, tutor);
    await grant(db.pool, learner, 10);

    await runSession(db.pool, learner, tutor, 2);
    const pending = await createRequest(db.pool, learner, 1);
    await assignAndAccept(db.pool, pending, learner, tutor); // 2 earned + 1 scheduled = 3
    const extra = await createRequest(db.pool, learner, 1);
    await expect(
      asUser(db.pool, learner, (c) => c.query("select assign_tutor($1, $2)", [extra, tutor])),
    ).rejects.toThrow(/PAIR_WEEKLY_CAP/);
  });

  test("the ledger trigger itself rejects session_taught entries beyond the cap", async () => {
    const tutor = await createUser(db.pool, "capTutor3");
    const learner = await createUser(db.pool, "capLearner3");
    await makeTutor(db.pool, tutor);
    await grant(db.pool, learner, 10);
    await runSession(db.pool, learner, tutor, 3);

    // Forge an extra session row directly (privileged), then try to credit it.
    const { rows: [req] } = await db.pool.query(
      `insert into help_requests (learner_id, course_code, topic, preferred_start, duration_hours, status, tutor_id)
       values ($1, 'TK3-01', 'forged', now(), 1, 'accepted', $2) returning id`,
      [learner, tutor],
    );
    const { rows: [sess] } = await db.pool.query(
      `insert into tutoring_sessions (request_id, tutor_id, learner_id, course_code, scheduled_start, duration_hours)
       values ($1, $2, $3, 'TK3-01', now(), 1) returning id`,
      [req.id, tutor, learner],
    );
    await expect(
      db.pool.query(
        `insert into credit_ledger (user_id, delta, reason, session_id, counterparty_id)
         values ($1, 1, 'session_taught', $2, $3)`,
        [tutor, sess.id, learner],
      ),
    ).rejects.toThrow(/PAIR_WEEKLY_CAP/);
  });
});

describe("append-only ledger", () => {
  test("ledger rows cannot be updated, deleted or truncated, even by the owner", async () => {
    const user = await createUser(db.pool, "immutable");
    await expect(db.pool.query("update credit_ledger set delta = 100 where user_id = $1", [user])).rejects.toThrow(
      /LEDGER_APPEND_ONLY/,
    );
    await expect(db.pool.query("delete from credit_ledger where user_id = $1", [user])).rejects.toThrow(
      /LEDGER_APPEND_ONLY/,
    );
    await expect(db.pool.query("truncate credit_ledger cascade")).rejects.toThrow(/LEDGER_APPEND_ONLY/);
    expect(await balance(db.pool, user)).toBe(2);
  });
});
