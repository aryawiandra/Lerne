// DEV BYPASS session cookie (local demo mode only): "<userId>.<expEpoch>.<hmac>".
// HMAC-SHA256 with LERNE_SESSION_SECRET; verified in constant time.
import { createHmac, timingSafeEqual } from "node:crypto";

export const DEV_SESSION_COOKIE = "lerne_dev_session";
export const DEV_SESSION_TTL_SECONDS = 60 * 60 * 8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signDevSession(userId: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  if (!UUID.test(userId)) throw new Error("signDevSession: invalid user id");
  const payload = `${userId}.${nowSeconds + DEV_SESSION_TTL_SECONDS}`;
  return `${payload}.${mac(payload, secret)}`;
}

/** Returns the user id if the cookie is authentic and unexpired, else null. */
export function verifyDevSession(
  value: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [userId, expRaw, signature] = parts;
  if (!UUID.test(userId) || !/^\d{1,12}$/.test(expRaw)) return null;

  const expected = Buffer.from(mac(`${userId}.${expRaw}`, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (Number(expRaw) < nowSeconds) return null;
  return userId;
}
