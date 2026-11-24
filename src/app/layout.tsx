import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { signOut } from "@/app/actions/auth";
import { getCurrentUser } from "@/lib/auth";
import { isDevAuth } from "@/lib/config";
import { getCreditSummary } from "@/lib/queries";

// Every page depends on the signed-in user; never prerender.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lerne — peer tutoring time bank",
  description: "Teach an hour, earn an hour. Prototype for STACK 2026.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const user = await getCurrentUser();
  const credits = user ? await getCreditSummary(user.id) : null;
  const devMode = isDevAuth();

  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-slate-50 font-sans text-slate-900">
        {devMode && (
          <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-900">
            PROTOTYPE · local demo mode · dev sign-in bypass (no email verification) · all accounts and data are
            synthetic
          </div>
        )}
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-4 px-4 py-3">
            <Link href={user ? "/dashboard" : "/login"} className="text-lg font-semibold text-teal-800">
              Lerne
            </Link>
            {user && (
              <>
                <nav className="flex gap-4 text-sm">
                  <Link href="/dashboard" className="hover:text-teal-800">Dashboard</Link>
                  <Link href="/requests/new" className="hover:text-teal-800">Ask for help</Link>
                  <Link href="/profile" className="hover:text-teal-800">Teach</Link>
                </nav>
                <div className="ml-auto flex items-center gap-3 text-sm">
                  <span data-testid="header-balance" className="rounded-full bg-teal-50 px-3 py-1 text-teal-900">
                    {credits?.balance ?? 0} credits
                  </span>
                  <span className="text-slate-600">{user.displayName}</span>
                  <form action={signOut}>
                    <button type="submit" className="text-slate-500 underline hover:text-slate-800">
                      Sign out
                    </button>
                  </form>
                </div>
              </>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
