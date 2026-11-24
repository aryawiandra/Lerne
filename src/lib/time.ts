// All scheduling in Lerne uses WIB (Asia/Jakarta, UTC+7, no daylight saving),
// so conversions are fixed-offset arithmetic and fully deterministic.

export const APP_TIMEZONE = "Asia/Jakarta";
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
export const MINUTES_PER_DAY = 1440;

/** ISO weekday labels, index 1 = Monday .. 7 = Sunday. */
export const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

export interface WibParts {
  /** ISO weekday: 1 = Monday .. 7 = Sunday */
  dayOfWeek: number;
  /** minutes since 00:00 WIB */
  minuteOfDay: number;
}

export function toWibParts(date: Date): WibParts {
  const shifted = new Date(date.getTime() + WIB_OFFSET_MS);
  const jsDay = shifted.getUTCDay();
  return {
    dayOfWeek: jsDay === 0 ? 7 : jsDay,
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Parses an <input type="datetime-local"> value interpreted as WIB. */
export function parseWibLocalInput(value: string): Date | null {
  const m = LOCAL_INPUT.exec(value.trim());
  if (!m) return null;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+07:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Formats a Date as an <input type="datetime-local"> value in WIB. */
export function toWibLocalInput(date: Date): string {
  return new Date(date.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 16);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** datetime-local value for tomorrow at the given WIB hour (form default). */
export function tomorrowAtWibHour(hour: number, now: Date = new Date()): string {
  const day = toWibLocalInput(new Date(now.getTime() + DAY_MS)).slice(0, 10);
  return `${day}T${String(hour).padStart(2, "0")}:00`;
}

export function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Parses "HH:MM" (24 h) into minutes since midnight; "24:00" allowed as end of day. */
export function parseMinute(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[2]) > 59 || minutes > MINUTES_PER_DAY) return null;
  return minutes;
}

export function formatWib(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date) + " WIB";
}
