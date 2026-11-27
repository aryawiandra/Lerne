// SYNTHETIC demo data. Every account here is fictional, flagged
// profiles.is_synthetic = true, and named "<Name> (demo)". The rating history is
// produced by running real sessions through the same SQL functions the app
// uses — it is NOT real usage data.
import type { Pool } from "pg";
import { addSlot, createUser, makeTutor, rate, runSession, setWeeklyLimit } from "../db/flows";

const MON = 1;
const TUE = 2;
const WED = 3;
const THU = 4;
const h = (hour: number) => hour * 60;

interface DemoUser {
  key: string;
  name: string;
  courses: string[];
  slots: Array<[day: number, start: number, end: number]>;
}

export const DEMO_USERS: readonly DemoUser[] = [
  { key: "bima", name: "Bima (demo learner)", courses: ["TK1-01"], slots: [[TUE, h(19), h(21)]] },
  { key: "alya", name: "Alya (demo)", courses: ["TK3-01", "TK2-03"], slots: [[MON, h(13), h(17)], [WED, h(9), h(12)]] },
  { key: "citra", name: "Citra (demo)", courses: ["TK3-01", "TK4-03"], slots: [[MON, h(14), h(15)], [THU, h(13), h(16)]] },
  { key: "dimas", name: "Dimas (demo)", courses: ["TK3-01", "TK2-05"], slots: [[TUE, h(10), h(12)]] },
  { key: "eka", name: "Eka (demo)", courses: ["TK3-01", "TK4-01"], slots: [[MON, h(15), h(18)]] },
  { key: "fajar", name: "Fajar (demo)", courses: [], slots: [] },
  { key: "gita", name: "Gita (demo)", courses: [], slots: [] },
];

/** Historical sessions: [learner, tutor, learner's rating of tutor, tutor's rating of learner]. */
const HISTORY: ReadonlyArray<[string, string, number, number]> = [
  ["fajar", "citra", 5, 5],
  ["gita", "citra", 4, 5],
  ["fajar", "dimas", 3, 4],
  ["gita", "alya", 4, 4],
];

export async function seedDemoData(pool: Pool): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const user of DEMO_USERS) {
    ids[user.key] = await createUser(pool, `demo.${user.key}@ui.ac.id`, user.name);
    if (user.courses.length > 0) {
      await makeTutor(pool, ids[user.key], user.courses);
      await setWeeklyLimit(pool, ids[user.key], 5); // SYNTHETIC history packs several sessions into one week
    }
    for (const [day, start, end] of user.slots) await addSlot(pool, ids[user.key], day, start, end);
  }
  for (const [learner, tutor, learnerScore, tutorScore] of HISTORY) {
    const sessionId = await runSession(pool, ids[learner], ids[tutor], 1, "TK3-01", "[synthetic history] practice");
    await rate(pool, ids[learner], sessionId, learnerScore);
    await rate(pool, ids[tutor], sessionId, tutorScore);
  }
  return ids;
}
