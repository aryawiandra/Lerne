"use server";

import { revalidatePath } from "next/cache";
import QRCode from "qrcode";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { rows, withUser } from "@/lib/db";
import { failure, type FormState } from "@/lib/errors";

export interface TokenState extends FormState {
  token?: string;
  expiresAt?: string;
  qrDataUrl?: string;
}

const issueSchema = z.object({ sessionId: z.uuid(), phase: z.enum(["start", "end"]) });

/** Tutor: issue a short-lived signed token (signed inside Postgres) and render it as a QR code. */
export async function issueToken(_prev: TokenState, formData: FormData): Promise<TokenState> {
  const user = await requireUser();
  const parsed = issueSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Invalid session." };
  try {
    const [row] = await withUser(user.id, (c) =>
      rows<{ token: string; expires_at: Date }>(c, "select token, expires_at from issue_session_token($1, $2)", [
        parsed.data.sessionId,
        parsed.data.phase,
      ]),
    );
    const qrDataUrl = await QRCode.toDataURL(row.token, { margin: 1, width: 280, errorCorrectionLevel: "M" });
    return { token: row.token, expiresAt: row.expires_at.toISOString(), qrDataUrl };
  } catch (error) {
    return failure(error);
  }
}

const TOKEN_SHAPE = /^[0-9a-f-]{36}\.(start|end)\.\d{1,12}\.[0-9a-f]{32}$/;

/** Learner: redeem the tutor's token to start or end the session. */
export async function redeemToken(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const token = String(formData.get("token") ?? "").trim();
  const sessionId = String(formData.get("sessionId") ?? "");
  if (!TOKEN_SHAPE.test(token)) return { error: "That does not look like a Lerne session code." };
  try {
    const [row] = await withUser(user.id, (c) =>
      rows<{ status: string }>(c, "select redeem_session_token($1) as status", [token]),
    );
    revalidatePath(`/sessions/${sessionId}`);
    revalidatePath("/dashboard");
    return { ok: row.status === "completed" ? "Session ended — credits transferred." : "Session started." };
  } catch (error) {
    return failure(error);
  }
}

const rateSchema = z.object({ sessionId: z.uuid(), score: z.coerce.number().int().min(1).max(5) });

export async function rateSession(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const parsed = rateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Choose a rating from 1 to 5." };
  try {
    await withUser(user.id, (c) => c.query("select rate_session($1, $2)", [parsed.data.sessionId, parsed.data.score]));
  } catch (error) {
    return failure(error);
  }
  revalidatePath(`/sessions/${parsed.data.sessionId}`);
  return { ok: "Thanks for rating!" };
}
