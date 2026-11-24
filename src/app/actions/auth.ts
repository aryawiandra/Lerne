"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { clearSession, createSupabaseServerClient, setDevSessionCookie } from "@/lib/auth";
import { normalizeCampusEmail } from "@/lib/campusEmail";
import { isDevAuth } from "@/lib/config";
import { privilegedQuery } from "@/lib/db";
import { failure, type FormState } from "@/lib/errors";

const CAMPUS_ONLY = "Use your @ui.ac.id campus email.";

export interface OtpState extends FormState {
  email?: string;
}

/**
 * DEV BYPASS (local demo mode only): signs in as the given @ui.ac.id address
 * WITHOUT email verification, creating the account if needed. Accounts made
 * this way are flagged is_synthetic. Disabled when LERNE_AUTH_MODE=supabase.
 */
export async function devSignIn(_prev: FormState, formData: FormData): Promise<FormState> {
  if (!isDevAuth()) return { error: "Dev sign-in is disabled." };
  const email = normalizeCampusEmail(String(formData.get("email") ?? ""));
  if (!email) return { error: CAMPUS_ONLY };

  try {
    await privilegedQuery(
      `insert into auth.users (email, raw_user_meta_data) values ($1, jsonb_build_object('is_synthetic', true))
       on conflict (email) do nothing`,
      [email],
    );
    const [user] = await privilegedQuery<{ id: string }>("select id from auth.users where email = $1", [email]);
    await setDevSessionCookie(user.id);
  } catch (error) {
    return failure(error);
  }
  redirect("/dashboard");
}

/** Supabase mode: step 1 — email a one-time code (domain checked first). */
export async function sendOtp(_prev: OtpState, formData: FormData): Promise<OtpState> {
  const email = normalizeCampusEmail(String(formData.get("email") ?? ""));
  if (!email) return { error: CAMPUS_ONLY };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) return { error: `Could not send code: ${error.message}`, email };
  return { ok: "We emailed you a 6-digit code.", email };
}

const otpSchema = z.object({ email: z.string(), token: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") });

/** Supabase mode: step 2 — verify the code and start the session. */
export async function verifyOtp(_prev: OtpState, formData: FormData): Promise<OtpState> {
  const parsed = otpSchema.safeParse({ email: formData.get("email"), token: formData.get("token") });
  if (!parsed.success) return { error: parsed.error.issues[0].message, email: String(formData.get("email") ?? "") };
  const email = normalizeCampusEmail(parsed.data.email);
  if (!email) return { error: CAMPUS_ONLY };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({ email, token: parsed.data.token, type: "email" });
  if (error) return { error: `Code rejected: ${error.message}`, email };
  redirect("/dashboard");
}

export async function signOut(): Promise<void> {
  await clearSession();
  redirect("/login");
}
