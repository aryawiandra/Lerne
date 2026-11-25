"""Agent-based simulation of the Lerne credit economy (SYNTHETIC, not user evidence).

Purpose: test whether the credit rules (starting credits, no negative balance,
safety-net credit) let a small community keep exchanging help over a full
16-week semester, and how sensitive that is to tutor supply. Every input is an
assumption, listed in ASSUMPTIONS and written to results.json with the results.
Limitations: a declined request is offered to the next tutor in rank order, all within one week;
each learner requests at most once a week, so the weekly pair cap
never binds here; it is a fraud control and is not tested by this model.
"""
import json
import random
import statistics
import sys
from dataclasses import dataclass

COURSES = [f"C{i}" for i in range(1, 9)]  # 8 high-demand mandatory courses, semesters 1-4
WEEKS = 16
RUNS = 200
SLOTS_PER_WEEK = 10
MAX_WEEKLY_TEACHING = 2
PROFILE = {1: (0.15, 0.55), 2: (0.35, 0.45), 3: (0.55, 0.25), 4: (0.65, 0.15)}  # (teach prob, need prob)
COHORT = [1] * 15 + [2] * 15 + [3] * 12 + [4] * 8

ASSUMPTIONS = {
    "students": "50 synthetic students: 15 year-1, 15 year-2, 12 year-3, 8 year-4; 16-week semester",
    "mastery": "can teach a course with prob 0.15 (y1), 0.35 (y2), 0.55 (y3), 0.65 (y4); 'low supply' halves these",
    "need": "weekly prob of needing help 0.55 (y1), 0.45 (y2), 0.25 (y3), 0.15 (y4); course drawn uniformly",
    "avoidance": "23% are help-avoidant (Karabenick 2003) and request with half the base prob",
    "availability": "each student is free in 3-6 of 10 weekly slots",
    "tutor_willingness": "each of up to 3 suggested tutors (8 in 'fall-through') accepts with prob 0.6 (0.3 in 'low supply'); max 2 h teaching per week",
    "session": "1 h per session; +1 tutor, -1 learner; balance never below zero",
    "recruited_seniors": "scenario C adds 10 senior tutors who teach 80% of courses and never request",
    "safety_net": "a student at zero gets +1 credit at the start of a week, at most N grants per semester",
}


@dataclass(frozen=True)
class Rules:
    start_credits: int = 2
    seniors: int = 0
    safety_net_cap: int = 0
    accept: float = 0.6
    mastery_scale: float = 1.0
    candidates: int = 3


def make_students(rng, rules):
    students = []
    for sid, y in enumerate(COHORT + [4] * rules.seniors):
        teach_p, need_p = PROFILE[y]
        recruited = sid >= len(COHORT)
        p = 0.8 if recruited else teach_p * rules.mastery_scale
        students.append({
            "id": sid, "year": y, "recruited": recruited,
            "teach": frozenset(c for c in COURSES if rng.random() < p),
            "need_p": 0.0 if recruited else need_p,
            "avoidant": (not recruited) and rng.random() < 0.23,
            "slots": frozenset(rng.sample(range(SLOTS_PER_WEEK), rng.randint(3, 6))),
        })
    return students


def find_tutor(rng, students, learner, course, load, ratings, accept, candidates):
    cands = [t for t in students
             if t["id"] != learner["id"] and course in t["teach"]
             and t["slots"] & learner["slots"] and load[t["id"]] < MAX_WEEKLY_TEACHING]
    cands.sort(key=lambda t: (len(t["slots"] & learner["slots"]),
                              statistics.mean(ratings[t["id"]]) if ratings[t["id"]] else 4.0),
               reverse=True)
    return next((t for t in cands[:candidates] if rng.random() < accept), None)


def grant_safety_net(students, bal, grants, cap):
    granted = 0
    for s in students:
        if bal[s["id"]] == 0 and grants[s["id"]] < cap:
            bal = {**bal, s["id"]: 1}
            grants = {**grants, s["id"]: grants[s["id"]] + 1}
            granted += 1
    return bal, grants, granted


def run_once(rng, rules):
    students = make_students(rng, rules)
    bal = {s["id"]: rules.start_credits for s in students}
    grants = {s["id"]: 0 for s in students}
    ratings = {s["id"]: [] for s in students}
    stats = {"requests": 0, "matched": 0, "blocked_balance": 0, "no_tutor": 0, "grants": 0}
    for _ in range(WEEKS):
        bal, grants, granted = grant_safety_net(students, bal, grants, rules.safety_net_cap)
        stats["grants"] += granted
        load = {s["id"]: 0 for s in students}
        for s in rng.sample(students, len(students)):
            if rng.random() >= s["need_p"] * (0.5 if s["avoidant"] else 1.0):
                continue
            course = rng.choice(COURSES)
            if course in s["teach"]:
                continue
            stats["requests"] += 1
            if bal[s["id"]] < 1:
                stats["blocked_balance"] += 1
                continue
            tutor = find_tutor(rng, students, s, course, load, ratings, rules.accept, rules.candidates)
            if tutor is None:
                stats["no_tutor"] += 1
                continue
            bal = {**bal, s["id"]: bal[s["id"]] - 1, tutor["id"]: bal[tutor["id"]] + 1}
            load[tutor["id"]] += 1
            ratings[tutor["id"]].append(rng.randint(3, 5))
            stats["matched"] += 1
    y1 = [s for s in students if s["year"] == 1 and not s["recruited"]]
    return {**stats, "y1_zero_end": sum(bal[s["id"]] == 0 for s in y1) / len(y1)}


def scenario(name, rules, seed=2026):
    rng = random.Random(seed)
    rows = [run_once(rng, rules) for _ in range(RUNS)]
    req = sum(r["requests"] for r in rows)
    pct = lambda key: round(100 * sum(r[key] for r in rows) / req, 1)
    return {
        "scenario": name,
        "matched_pct": pct("matched"),
        "blocked_by_balance_pct": pct("blocked_balance"),
        "no_tutor_pct": pct("no_tutor"),
        "hours_per_week": round(statistics.mean(r["matched"] for r in rows) / WEEKS, 1),
        "grants_per_week": round(statistics.mean(r["grants"] for r in rows) / WEEKS, 1),
        "y1_zero_balance_at_end_pct": round(100 * statistics.mean(r["y1_zero_end"] for r in rows), 1),
    }


def main():
    results = [
        scenario("A. No starting credits", Rules(start_credits=0)),
        scenario("B. 2 starting credits", Rules()),
        scenario("C. B + 10 recruited senior tutors", Rules(seniors=10)),
        scenario("D. B + safety net, max 4 per semester", Rules(safety_net_cap=4)),
        scenario("E. B + safety net, max 6 per semester (adopted)", Rules(safety_net_cap=6)),
        scenario("F. E with low tutor supply (sensitivity)", Rules(safety_net_cap=6, accept=0.3, mastery_scale=0.5)),
        scenario("G. F + 10 recruited senior tutors", Rules(safety_net_cap=6, accept=0.3, mastery_scale=0.5, seniors=10)),
        scenario("H. G + fall-through to up to 8 tutors (adopted)", Rules(safety_net_cap=6, accept=0.3, mastery_scale=0.5, seniors=10, candidates=8)),
    ]
    json.dump({"assumptions": ASSUMPTIONS, "weeks": WEEKS, "runs": RUNS, "results": results},
              sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main()
