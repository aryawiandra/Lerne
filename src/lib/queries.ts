// Read models for pages. Everything runs through withUser(), so RLS decides
// what each user can see.
import { rows, withUser } from "./db";
import { rankTutors, type RankedTutor, type Slot } from "./matching";
import { toWibParts } from "./time";

export interface Course {
  code: string;
  name: string;
  semester: number;
}

export interface CreditSummary {
  balance: number;
  reserved: number;
  available: number;
}

export interface LedgerEntry {
  id: string;
  delta: number;
  reason: string;
  createdAt: Date;
  counterpartyName: string | null;
}

export interface RequestView {
  id: string;
  learnerId: string;
  learnerName: string;
  tutorId: string | null;
  tutorName: string | null;
  courseCode: string;
  courseName: string;
  topic: string;
  preferredStart: Date;
  durationHours: number;
  status: string;
  sessionId: string | null;
}

export interface SessionView {
  id: string;
  requestId: string;
  tutorId: string;
  tutorName: string;
  learnerId: string;
  learnerName: string;
  courseCode: string;
  courseName: string;
  topic: string;
  scheduledStart: Date;
  durationHours: number;
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  creditsTransferred: number | null;
  myRating: number | null;
}

export interface SlotView extends Slot {
  id: string;
}

export function getCourses(userId: string): Promise<Course[]> {
  return withUser(userId, (c) =>
    rows<Course>(c, "select code, name, semester from courses order by semester, code"),
  );
}

export function getCreditSummary(userId: string): Promise<CreditSummary> {
  return withUser(userId, async (c) => {
    const [row] = await rows<CreditSummary>(c, "select balance, reserved, available from my_credit_summary()");
    return row;
  });
}

export interface SafetyNetStatus {
  grantedThisWeek: boolean;
  usedThisSemester: number;
  maxPerSemester: number;
}

/** Grants the weekly safety-net credit if the user is at zero (the database decides; idempotent per week). */
export function claimSafetyNet(userId: string): Promise<boolean> {
  return withUser(userId, async (c) => {
    const [row] = await rows<{ granted: number }>(c, "select claim_safety_net_credit() as granted");
    return row.granted === 1;
  });
}

export function getSafetyNetStatus(userId: string): Promise<SafetyNetStatus> {
  return withUser(userId, async (c) => {
    const [row] = await rows<{ this_week: boolean; used: number; max: number }>(
      c,
      `select exists (select 1 from credit_ledger
                      where reason = 'safety_net_grant'
                        and date_trunc('week', created_at at time zone lerne_timezone())
                            = date_trunc('week', now() at time zone lerne_timezone())) as this_week,
              my_safety_net_used() as used, lerne_safety_net_max_per_semester() as max`,
    );
    return { grantedThisWeek: row.this_week, usedThisSemester: row.used, maxPerSemester: row.max };
  });
}

export function getWeeklySessionLimit(userId: string): Promise<number> {
  return withUser(userId, async (c) => {
    const [row] = await rows<{ weekly_limit: number }>(
      c,
      "select weekly_session_limit as weekly_limit from profiles where id = auth.uid()",
    );
    return row.weekly_limit;
  });
}

export interface FallthroughStatus {
  declined: number;
  maxTutors: number;
}

export function getFallthrough(userId: string, requestId: string): Promise<FallthroughStatus> {
  return withUser(userId, async (c) => {
    const [row] = await rows<{ declined: number; max: number }>(
      c,
      "select (select count(*)::int from request_declines where request_id = $1) as declined, lerne_fallthrough_max_tutors() as max",
      [requestId],
    );
    return { declined: row.declined, maxTutors: row.max };
  });
}

export function getLedger(userId: string): Promise<LedgerEntry[]> {
  return withUser(userId, (c) =>
    rows<LedgerEntry>(
      c,
      `select l.id::text as id, l.delta, l.reason, l.created_at as "createdAt", p.display_name as "counterpartyName"
       from credit_ledger l left join profiles p on p.id = l.counterparty_id
       order by l.id desc limit 50`,
    ),
  );
}

export function getMyTutorCourses(userId: string): Promise<string[]> {
  return withUser(userId, async (c) => {
    const list = await rows<{ course_code: string }>(
      c,
      "select course_code from tutor_courses where user_id = auth.uid()",
    );
    return list.map((r) => r.course_code);
  });
}

export function getMySlots(userId: string): Promise<SlotView[]> {
  return withUser(userId, (c) =>
    rows<SlotView>(
      c,
      `select id, day_of_week as "dayOfWeek", start_minute as "startMinute", end_minute as "endMinute"
       from availability_slots where user_id = auth.uid() order by day_of_week, start_minute`,
    ),
  );
}

const REQUEST_SELECT = `
  select r.id, r.learner_id as "learnerId", lp.display_name as "learnerName",
         r.tutor_id as "tutorId", tp.display_name as "tutorName",
         r.course_code as "courseCode", co.name as "courseName", r.topic,
         r.preferred_start as "preferredStart", r.duration_hours as "durationHours", r.status,
         s.id as "sessionId"
  from help_requests r
  join profiles lp on lp.id = r.learner_id
  left join profiles tp on tp.id = r.tutor_id
  join courses co on co.code = r.course_code
  left join tutoring_sessions s on s.request_id = r.id`;

export function getMyRequests(userId: string): Promise<RequestView[]> {
  return withUser(userId, (c) =>
    rows<RequestView>(c, `${REQUEST_SELECT} where r.learner_id = auth.uid() order by r.created_at desc limit 20`),
  );
}

export function getIncomingRequests(userId: string): Promise<RequestView[]> {
  return withUser(userId, (c) =>
    rows<RequestView>(
      c,
      `${REQUEST_SELECT} where r.tutor_id = auth.uid() and r.status = 'pending' order by r.preferred_start`,
    ),
  );
}

export function getRequest(userId: string, requestId: string): Promise<RequestView | null> {
  return withUser(userId, async (c) => {
    const [row] = await rows<RequestView>(c, `${REQUEST_SELECT} where r.id = $1`, [requestId]);
    return row ?? null;
  });
}

interface CandidateRow {
  tutor_id: string;
  display_name: string;
  slots: Slot[];
  rating_avg: string | null;
  rating_count: number;
  pair_credits_this_week: number;
  declined: boolean;
  sessions_in_week: number;
  weekly_session_limit: number;
}

export function getSuggestions(userId: string, request: RequestView): Promise<RankedTutor[]> {
  return withUser(userId, async (c) => {
    const candidates = await rows<CandidateRow>(c, "select * from match_candidates($1)", [request.id]);
    const [{ cap }] = await rows<{ cap: number }>(c, "select lerne_pair_weekly_cap() as cap");
    const { dayOfWeek, minuteOfDay } = toWibParts(request.preferredStart);
    return rankTutors(
      { learnerId: userId, dayOfWeek, startMinute: minuteOfDay, durationHours: request.durationHours, pairWeeklyCap: cap },
      candidates.map((r) => ({
        tutorId: r.tutor_id,
        displayName: r.display_name,
        teachesCourse: true, // match_candidates already filters by course
        slots: r.slots,
        ratingAvg: r.rating_avg === null ? null : Number(r.rating_avg),
        ratingCount: r.rating_count,
        pairCreditsThisWeek: r.pair_credits_this_week,
        declined: r.declined,
        sessionsInWeek: r.sessions_in_week,
        weeklySessionLimit: r.weekly_session_limit,
      })),
    );
  });
}

const SESSION_SELECT = `
  select s.id, s.request_id as "requestId", s.tutor_id as "tutorId", tp.display_name as "tutorName",
         s.learner_id as "learnerId", lp.display_name as "learnerName",
         s.course_code as "courseCode", co.name as "courseName", r.topic,
         s.scheduled_start as "scheduledStart", s.duration_hours as "durationHours", s.status,
         s.started_at as "startedAt", s.ended_at as "endedAt", s.credits_transferred as "creditsTransferred",
         (select score from ratings rt where rt.session_id = s.id and rt.rater_id = auth.uid()) as "myRating"
  from tutoring_sessions s
  join profiles tp on tp.id = s.tutor_id
  join profiles lp on lp.id = s.learner_id
  join courses co on co.code = s.course_code
  join help_requests r on r.id = s.request_id`;

export function getMySessions(userId: string): Promise<SessionView[]> {
  return withUser(userId, (c) =>
    rows<SessionView>(c, `${SESSION_SELECT} order by s.created_at desc limit 20`),
  );
}

export function getSession(userId: string, sessionId: string): Promise<SessionView | null> {
  return withUser(userId, async (c) => {
    const [row] = await rows<SessionView>(c, `${SESSION_SELECT} where s.id = $1`, [sessionId]);
    return row ?? null;
  });
}
