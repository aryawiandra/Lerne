import { describe, expect, test } from "vitest";
import { isEligible, MAX_SUGGESTIONS, overlapMinutes, rankTutors, type MatchQuery, type TutorCandidate } from "@/lib/matching";

const MONDAY = 1;
const TUESDAY = 2;
const at = (h: number, m = 0) => h * 60 + m;

function tutor(overrides: Partial<TutorCandidate> & { tutorId: string }): TutorCandidate {
  return {
    displayName: overrides.tutorId,
    teachesCourse: true,
    slots: [],
    ratingAvg: null,
    ratingCount: 0,
    pairCreditsThisWeek: 0,
    declined: false,
    sessionsInWeek: 0,
    weeklySessionLimit: 2,
    ...overrides,
  };
}

const query: MatchQuery = {
  learnerId: "learner",
  dayOfWeek: MONDAY,
  startMinute: at(14),
  durationHours: 1,
  pairWeeklyCap: 3,
};

describe("overlapMinutes", () => {
  test("counts minutes of the window covered by a same-day slot", () => {
    // Arrange
    const slots = [{ dayOfWeek: MONDAY, startMinute: at(14, 30), endMinute: at(17) }];
    // Act
    const overlap = overlapMinutes(slots, MONDAY, at(14), 60);
    // Assert
    expect(overlap).toBe(30);
  });

  test("ignores slots on other days", () => {
    const slots = [{ dayOfWeek: TUESDAY, startMinute: at(8), endMinute: at(20) }];
    expect(overlapMinutes(slots, MONDAY, at(14), 60)).toBe(0);
  });

  test("merges adjacent and overlapping slots without double counting", () => {
    const slots = [
      { dayOfWeek: MONDAY, startMinute: at(13), endMinute: at(14, 30) },
      { dayOfWeek: MONDAY, startMinute: at(14), endMinute: at(15) },
      { dayOfWeek: MONDAY, startMinute: at(14, 15), endMinute: at(14, 45) },
    ];
    expect(overlapMinutes(slots, MONDAY, at(14), 60)).toBe(60);
  });

  test("clips a window that would run past midnight", () => {
    const slots = [{ dayOfWeek: MONDAY, startMinute: at(23), endMinute: 1440 }];
    expect(overlapMinutes(slots, MONDAY, at(23, 30), 120)).toBe(30);
  });
});

describe("isEligible", () => {
  test("rejects tutors who do not teach the course", () => {
    expect(isEligible(query, tutor({ tutorId: "t", teachesCourse: false }))).toBe(false);
  });

  test("rejects the learner themself", () => {
    expect(isEligible(query, tutor({ tutorId: "learner" }))).toBe(false);
  });

  test("rejects a tutor who already declined this request", () => {
    expect(isEligible(query, tutor({ tutorId: "t", declined: true }))).toBe(false);
  });

  test("rejects a tutor whose weekly pair cap would be exceeded", () => {
    expect(isEligible(query, tutor({ tutorId: "t", pairCreditsThisWeek: 3 }))).toBe(false);
    expect(isEligible({ ...query, durationHours: 2 }, tutor({ tutorId: "t", pairCreditsThisWeek: 2 }))).toBe(false);
  });

  test("accepts a tutor exactly at the cap boundary", () => {
    expect(isEligible(query, tutor({ tutorId: "t", pairCreditsThisWeek: 2 }))).toBe(true);
  });
});

describe("rankTutors", () => {
  test("returns at most three suggestions", () => {
    const candidates = ["a", "b", "c", "d", "e"].map((id) => tutor({ tutorId: id }));
    expect(rankTutors(query, candidates)).toHaveLength(MAX_SUGGESTIONS);
  });

  test("returns an empty list when no tutor teaches the course", () => {
    const candidates = [tutor({ tutorId: "a", teachesCourse: false })];
    expect(rankTutors(query, candidates)).toEqual([]);
  });

  test("schedule overlap outranks rating", () => {
    // Arrange
    const freeAtTwo = tutor({
      tutorId: "free",
      ratingAvg: 3.2,
      ratingCount: 2,
      slots: [{ dayOfWeek: MONDAY, startMinute: at(13), endMinute: at(16) }],
    });
    const famousButBusy = tutor({ tutorId: "famous", ratingAvg: 5, ratingCount: 40 });
    // Act
    const ranked = rankTutors(query, [famousButBusy, freeAtTwo]);
    // Assert
    expect(ranked.map((t) => t.tutorId)).toEqual(["free", "famous"]);
    expect(ranked[0].coversWholeWindow).toBe(true);
    expect(ranked[1].overlapMinutes).toBe(0);
  });

  test("rating breaks ties between equal overlap; unrated tutors count as neutral 3", () => {
    const slot = [{ dayOfWeek: MONDAY, startMinute: at(14), endMinute: at(15) }];
    const ranked = rankTutors(query, [
      tutor({ tutorId: "low", ratingAvg: 2, ratingCount: 3, slots: slot }),
      tutor({ tutorId: "new", slots: slot }),
      tutor({ tutorId: "high", ratingAvg: 4.5, ratingCount: 3, slots: slot }),
    ]);
    expect(ranked.map((t) => t.tutorId)).toEqual(["high", "new", "low"]);
  });

  test("partial overlap ranks above no overlap but below full overlap", () => {
    const ranked = rankTutors(query, [
      tutor({ tutorId: "none" }),
      tutor({ tutorId: "partial", slots: [{ dayOfWeek: MONDAY, startMinute: at(14, 30), endMinute: at(18) }] }),
      tutor({ tutorId: "full", slots: [{ dayOfWeek: MONDAY, startMinute: at(9), endMinute: at(18) }] }),
    ]);
    expect(ranked.map((t) => [t.tutorId, t.overlapMinutes])).toEqual([
      ["full", 60],
      ["partial", 30],
      ["none", 0],
    ]);
  });

  test("more ratings win when overlap and average are equal", () => {
    const ranked = rankTutors(query, [
      tutor({ tutorId: "few", ratingAvg: 4, ratingCount: 1 }),
      tutor({ tutorId: "many", ratingAvg: 4, ratingCount: 9 }),
    ]);
    expect(ranked[0].tutorId).toBe("many");
  });

  test("filters out ineligible tutors before ranking and does not mutate input", () => {
    const candidates = Object.freeze([
      tutor({ tutorId: "capped", pairCreditsThisWeek: 3, ratingAvg: 5, ratingCount: 10 }),
      tutor({ tutorId: "ok" }),
    ]);
    const ranked = rankTutors(query, candidates);
    expect(ranked.map((t) => t.tutorId)).toEqual(["ok"]);
    expect(candidates[0]).not.toHaveProperty("overlapMinutes");
  });
});

describe("tutor weekly session limit", () => {
  test("excludes a tutor who already has their weekly maximum of sessions", () => {
    // Arrange
    const full = tutor({ tutorId: "full", sessionsInWeek: 2, weeklySessionLimit: 2 });
    const raised = tutor({ tutorId: "raised", sessionsInWeek: 2, weeklySessionLimit: 3 });
    // Act
    const ids = rankTutors(query, [full, raised]).map((t) => t.tutorId);
    // Assert
    expect(isEligible(query, full)).toBe(false);
    expect(ids).toEqual(["raised"]);
  });
});
