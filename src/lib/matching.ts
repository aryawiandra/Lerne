// Tutor matching — plain, explainable rules (no AI):
//   1. Eligibility (hard filters): tutor teaches the requested course, is not the
//      learner, has not declined this request, and taking this session would not
//      exceed the tutor-learner weekly credit cap.
//   2. Ranking: most minutes of the requested time window covered by the tutor's
//      weekly free slots → higher rating (unrated tutors count as NEUTRAL_RATING)
//      → more ratings (more evidence) → display name (stable tie-break).
//   3. Return at most MAX_SUGGESTIONS.
// Tutors with zero overlap are still suggested (after everyone with overlap),
// flagged so the UI can say "no matching free slot".

import { MINUTES_PER_DAY } from "./time";

export const MAX_SUGGESTIONS = 3;
export const NEUTRAL_RATING = 3;

export interface Slot {
  dayOfWeek: number; // ISO 1..7
  startMinute: number;
  endMinute: number;
}

export interface TutorCandidate {
  tutorId: string;
  displayName: string;
  teachesCourse: boolean;
  slots: readonly Slot[];
  ratingAvg: number | null;
  ratingCount: number;
  pairCreditsThisWeek: number;
  declined: boolean;
}

export interface MatchQuery {
  learnerId: string;
  dayOfWeek: number;
  startMinute: number;
  durationHours: number;
  pairWeeklyCap: number;
}

export interface RankedTutor extends TutorCandidate {
  overlapMinutes: number;
  coversWholeWindow: boolean;
  effectiveRating: number;
}

interface Interval {
  start: number;
  end: number;
}

function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  return sorted.reduce<Interval[]>((merged, current) => {
    const last = merged[merged.length - 1];
    if (last && current.start <= last.end) {
      return [...merged.slice(0, -1), { start: last.start, end: Math.max(last.end, current.end) }];
    }
    return [...merged, current];
  }, []);
}

/**
 * Minutes of [startMinute, startMinute + durationMinutes) on dayOfWeek covered
 * by the slots. The window is clipped at midnight (slots never cross midnight).
 */
export function overlapMinutes(
  slots: readonly Slot[],
  dayOfWeek: number,
  startMinute: number,
  durationMinutes: number,
): number {
  const windowEnd = Math.min(startMinute + durationMinutes, MINUTES_PER_DAY);
  const sameDay = slots
    .filter((s) => s.dayOfWeek === dayOfWeek)
    .map((s) => ({ start: s.startMinute, end: s.endMinute }));
  return mergeIntervals(sameDay).reduce((total, slot) => {
    const overlap = Math.min(slot.end, windowEnd) - Math.max(slot.start, startMinute);
    return total + Math.max(0, overlap);
  }, 0);
}

export function isEligible(query: MatchQuery, candidate: TutorCandidate): boolean {
  return (
    candidate.teachesCourse &&
    candidate.tutorId !== query.learnerId &&
    !candidate.declined &&
    candidate.pairCreditsThisWeek + query.durationHours <= query.pairWeeklyCap
  );
}

function compareRanked(a: RankedTutor, b: RankedTutor): number {
  return (
    b.overlapMinutes - a.overlapMinutes ||
    b.effectiveRating - a.effectiveRating ||
    b.ratingCount - a.ratingCount ||
    a.displayName.localeCompare(b.displayName) ||
    a.tutorId.localeCompare(b.tutorId)
  );
}

export function rankTutors(
  query: MatchQuery,
  candidates: readonly TutorCandidate[],
  limit: number = MAX_SUGGESTIONS,
): RankedTutor[] {
  const windowMinutes = Math.min(query.durationHours * 60, MINUTES_PER_DAY - query.startMinute);
  return candidates
    .filter((c) => isEligible(query, c))
    .map((c) => {
      const overlap = overlapMinutes(c.slots, query.dayOfWeek, query.startMinute, query.durationHours * 60);
      return {
        ...c,
        overlapMinutes: overlap,
        coversWholeWindow: overlap >= windowMinutes,
        effectiveRating: c.ratingAvg ?? NEUTRAL_RATING,
      };
    })
    .sort(compareRanked)
    .slice(0, limit);
}
