// Two auth modes, same data path:
//   * supabase — Supabase Auth email OTP; user id comes from supabase.auth.getUser().
//   * dev      — LOCAL DEMO BYPASS: no email is sent; a signed cookie holds the
//                user id. Refused in production unless explicitly allowed.
// In both modes all data access then goes through withUser() (RLS enforced).
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient } from "@supabase/ssr";
import { getConfig, isDevAuth } from "./config";
import { privilegedQuery } from "./db";
import { DEV_SESSION_COOKIE, DEV_SESSION_TTL_SECONDS, signDevSession, verifyDevSession } from "./devSession";

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  isSynthetic: boolean;
}

export async function createSupabaseServerClient() {
  const config = getConfig();
  const cookieStore = await cookies();
  return createServerClient(config.NEXT_PUBLIC_SUPABASE_URL!, config.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component render: cookies are read-only there.
          // Session refresh then happens on the next Server Action / route.
        }
      },
    },
  });
}

async function currentUserId(): Promise<string | null> {
  if (isDevAuth()) {
    const cookieStore = await cookies();
    return verifyDevSession(cookieStore.get(DEV_SESSION_COOKIE)?.value, getConfig().LERNE_SESSION_SECRET!);
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user.id;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const userId = await currentUserId();
  if (!userId) return null;
  const [profile] = await privilegedQuery<{ id: string; email: string; display_name: string; is_synthetic: boolean }>(
    "select id, email, display_name, is_synthetic from public.profiles where id = $1",
    [userId],
  );
  if (!profile) return null;
  return {
    id: profile.id,
    email: profile.email,
    displayName: profile.display_name,
    isSynthetic: profile.is_synthetic,
  };
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function setDevSessionCookie(userId: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(DEV_SESSION_COOKIE, signDevSession(userId, getConfig().LERNE_SESSION_SECRET!), {
    httpOnly: true,
    sameSite: "lax",
    secure: getConfig().NODE_ENV === "production",
    path: "/",
    maxAge: DEV_SESSION_TTL_SECONDS,
  });
}

export async function clearSession(): Promise<void> {
  if (isDevAuth()) {
    (await cookies()).delete(DEV_SESSION_COOKIE);
    return;
  }
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
}
