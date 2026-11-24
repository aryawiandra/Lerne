import { describe, expect, test } from "vitest";
import { normalizeCampusEmail } from "@/lib/campusEmail";
import { DEV_SESSION_TTL_SECONDS, signDevSession, verifyDevSession } from "@/lib/devSession";
import { parseMinute, parseWibLocalInput, toWibLocalInput, toWibParts } from "@/lib/time";

const SECRET = "test-secret-that-is-at-least-32-characters-long";
const USER = "8b5b3a8e-2a8e-4c43-9a3e-0d6c1f6f2b11";

describe("normalizeCampusEmail", () => {
  test("accepts and lower-cases @ui.ac.id addresses", () => {
    expect(normalizeCampusEmail("  Demo.Alya@UI.AC.ID ")).toBe("demo.alya@ui.ac.id");
  });

  test.each(["a@gmail.com", "a@ui.ac.id.evil.com", "a@fakeui.ac.id", "a@sub.ui.ac.id", "no-at-sign", ""])(
    "rejects %s",
    (email) => {
      expect(normalizeCampusEmail(email)).toBeNull();
    },
  );
});

describe("dev session cookie", () => {
  test("round-trips a valid session", () => {
    expect(verifyDevSession(signDevSession(USER, SECRET), SECRET)).toBe(USER);
  });

  test("rejects a cookie signed with another secret", () => {
    expect(verifyDevSession(signDevSession(USER, SECRET), `${SECRET}-other`)).toBeNull();
  });

  test("rejects a tampered user id", () => {
    const [, exp, sig] = signDevSession(USER, SECRET).split(".");
    const other = "00000000-0000-4000-8000-000000000000";
    expect(verifyDevSession(`${other}.${exp}.${sig}`, SECRET)).toBeNull();
  });

  test("rejects an expired cookie", () => {
    const now = 1_000_000;
    const cookie = signDevSession(USER, SECRET, now);
    expect(verifyDevSession(cookie, SECRET, now + DEV_SESSION_TTL_SECONDS + 1)).toBeNull();
  });

  test("rejects malformed values", () => {
    expect(verifyDevSession(undefined, SECRET)).toBeNull();
    expect(verifyDevSession("garbage", SECRET)).toBeNull();
  });
});

describe("WIB time helpers", () => {
  test("datetime-local input is interpreted as WIB (UTC+7)", () => {
    const date = parseWibLocalInput("2026-11-30T14:00");
    expect(date?.toISOString()).toBe("2026-11-30T07:00:00.000Z");
    expect(toWibParts(date!)).toEqual({ dayOfWeek: 1, minuteOfDay: 14 * 60 });
    expect(toWibLocalInput(date!)).toBe("2026-11-30T14:00");
  });

  test("a UTC Sunday evening is already Monday in WIB", () => {
    expect(toWibParts(new Date("2026-11-29T18:30:00Z"))).toEqual({ dayOfWeek: 1, minuteOfDay: 90 });
  });

  test("parses HH:MM and rejects invalid times", () => {
    expect(parseMinute("09:30")).toBe(570);
    expect(parseMinute("24:00")).toBe(1440);
    expect(parseMinute("24:30")).toBeNull();
    expect(parseMinute("12:75")).toBeNull();
    expect(parseWibLocalInput("tomorrow")).toBeNull();
  });
});
