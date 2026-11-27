// Rules added after the credit-economy simulation (supabase/migrations/0002_simulation_rules.sql):
// safety-net credit, fall-through to up to 8 tutors, and the tutor weekly load limit.
// Runs against a real local Postgres database with SYNTHETIC users.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { asUser } from "@/lib/dbTx";
import {
  assignAndAccept, balance, createRequest, createTestDb, createUser, grant, makeTutor, q,
  setWeeklyLimit, type TestDb,
} from "./harness";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb("lerne_test_sim_rules");
});

afterAll(async () => {
  await db?.close();
});

function claim(userId: string): Promise<number> {
  return asUser(db.pool, userId, async (c) => {
    const [row] = await q<{ granted: number }>(c, "select claim_safety_net_credit() as granted");
    return row.granted;
  });
}

function assign(requestId: string, learnerId: string, tutorId: string) {
  return asUser(db.pool, learnerId, (c) => c.query("select assign_tutor($1, $2)", [requestId, tutorId]));
}

function decline(requestId: string, tutorId: string) {
  return asUser(db.pool, tutorId, (c) => c.query("select respond_to_request($1, false)", [requestId]));
}

function accept(requestId: string, tutorId: string) {
  return asUser(db.pool, tutorId, (c) => c.query("select respond_to_request($1, true)", [requestId]));
}

function candidates(requestId: string, learnerId: string) {
  return asUser(db.pool, learnerId, (c) =>
    q<{ tutor_id: string; sessions_in_week: number; weekly_session_limit: number }>(
      c,
      "select tutor_id, sessions_in_week, weekly_session_limit from match_candidates($1)",
      [requestId],
    ),
  );
}

describe("safety-net credit (+1 at zero, once a week, max 6 per semester)", () => {
  test("a user at zero gets exactly one credit, and only once in the same week", async () => {
    // Arrange: spend the 2 starting credits
    const user = await createUser(db.pool, "broke");
    await grant(db.pool, user, -2);
    expect(await balance(db.pool, user)).toBe(0);

    // Act / Assert
    expect(await claim(user)).toBe(1);
    expect(await balance(db.pool, user)).toBe(1);
    await grant(db.pool, user, -1);
    expect(await claim(user)).toBe(0); // already had one this week
    expect(await balance(db.pool, user)).toBe(0);
  });

  test("a user with credits left gets nothing", async () => {
    const user = await createUser(db.pool, "solvent");
    expect(await claim(user)).toBe(0);
    expect(await balance(db.pool, user)).toBe(2);
  });

  test("after 6 safety-net credits this semester, no more are granted", async () => {
    // Arrange: 6 earlier grants inside the current semester, then back to zero
    const user = await createUser(db.pool, "sixGrants");
    await db.pool.query(
      `insert into credit_ledger (user_id, delta, reason, created_at)
       select $1, 1, 'safety_net_grant', public.lerne_semester_start(now()) + interval '1 minute'
       from generate_series(1, 6)`,
      [user],
    );
    await grant(db.pool, user, -8);
    expect(await balance(db.pool, user)).toBe(0);

    // Act / Assert
    expect(await claim(user)).toBe(0);
    const [used] = await asUser(db.pool, user, (c) => q<{ n: number }>(c, "select my_safety_net_used() as n"));
    expect(used.n).toBe(6);
  });

  test("semesters follow the UI calendar: 1 Aug and 1 Feb (WIB)", async () => {
    const { rows } = await db.pool.query(
      `select to_char(lerne_semester_start('2026-11-26 10:00+07') at time zone 'Asia/Jakarta', 'YYYY-MM-DD') as nov,
              to_char(lerne_semester_start('2027-01-15 10:00+07') at time zone 'Asia/Jakarta', 'YYYY-MM-DD') as jan,
              to_char(lerne_semester_start('2027-03-01 10:00+07') at time zone 'Asia/Jakarta', 'YYYY-MM-DD') as mar`,
    );
    expect(rows[0]).toEqual({ nov: "2026-08-01", jan: "2026-08-01", mar: "2027-02-01" });
  });

  test("clients cannot write safety-net credits directly", async () => {
    const user = await createUser(db.pool, "forger");
    await expect(
      asUser(db.pool, user, (c) =>
        c.query("insert into credit_ledger (user_id, delta, reason) values (auth.uid(), 1, 'safety_net_grant')"),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("fall-through: a request can be offered to at most 8 tutors", () => {
  test("after 8 declines the request has no candidates and a 9th tutor cannot be asked", async () => {
    // Arrange
    const learner = await createUser(db.pool, "ftLearner");
    const tutors: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      const tutor = await createUser(db.pool, `ftTutor${i}`);
      await makeTutor(db.pool, tutor);
      tutors.push(tutor);
    }
    const request = await createRequest(db.pool, learner, 1);

    // Act: eight tutors decline in turn; each decline reopens the request
    for (const tutor of tutors.slice(0, 8)) {
      await assign(request, learner, tutor);
      await decline(request, tutor);
    }

    // Assert
    expect(await candidates(request, learner)).toEqual([]);
    await expect(assign(request, learner, tutors[8])).rejects.toThrow(/FALLTHROUGH_LIMIT/);
  });

  test("after one decline the next qualified tutors are still suggested", async () => {
    const learner = await createUser(db.pool, "ftLearner2");
    const first = await createUser(db.pool, "ftFirst");
    const second = await createUser(db.pool, "ftSecond");
    await makeTutor(db.pool, first);
    await makeTutor(db.pool, second);
    const request = await createRequest(db.pool, learner, 1);

    await assign(request, learner, first);
    await decline(request, first);

    const ids = (await candidates(request, learner)).map((r) => r.tutor_id);
    expect(ids).toContain(second);
    expect(ids).toContain(first); // still returned, flagged declined; the app filters it out
    await assignAndAccept(db.pool, request, learner, second);
  });
});

describe("tutor weekly load limit (default 2, adjustable 1-10)", () => {
  test("a tutor at 2 sessions that week cannot be asked again until they raise the limit", async () => {
    // Arrange: two sessions with two different learners in the same week
    const tutor = await createUser(db.pool, "loadTutor");
    await makeTutor(db.pool, tutor);
    for (const label of ["loadA", "loadB"]) {
      const learner = await createUser(db.pool, label);
      await assignAndAccept(db.pool, await createRequest(db.pool, learner, 1), learner, tutor);
    }
    const third = await createUser(db.pool, "loadC");
    const request = await createRequest(db.pool, third, 1);

    // Act / Assert
    const [row] = (await candidates(request, third)).filter((r) => r.tutor_id === tutor);
    expect(row).toMatchObject({ sessions_in_week: 2, weekly_session_limit: 2 });
    await expect(assign(request, third, tutor)).rejects.toThrow(/TUTOR_WEEKLY_LOAD/);

    await setWeeklyLimit(db.pool, tutor, 3);
    await assignAndAccept(db.pool, request, third, tutor);
  });

  test("two pending requests cannot both be accepted past the limit", async () => {
    const tutor = await createUser(db.pool, "raceTutor");
    await makeTutor(db.pool, tutor);
    const learnerA = await createUser(db.pool, "raceA");
    await assignAndAccept(db.pool, await createRequest(db.pool, learnerA, 1), learnerA, tutor); // 1 of 2

    const learnerB = await createUser(db.pool, "raceB");
    const learnerC = await createUser(db.pool, "raceC");
    const requestB = await createRequest(db.pool, learnerB, 1);
    const requestC = await createRequest(db.pool, learnerC, 1);
    await assign(requestB, learnerB, tutor);
    await assign(requestC, learnerC, tutor); // both pending while the tutor has 1 session

    await accept(requestB, tutor); // 2 of 2
    await expect(accept(requestC, tutor)).rejects.toThrow(/TUTOR_WEEKLY_LOAD/);
  });

  test("the limit must be between 1 and 10", async () => {
    const tutor = await createUser(db.pool, "badLimit");
    await expect(setWeeklyLimit(db.pool, tutor, 0)).rejects.toThrow(/INVALID_INPUT/);
    await expect(setWeeklyLimit(db.pool, tutor, 11)).rejects.toThrow(/INVALID_INPUT/);
  });
});
