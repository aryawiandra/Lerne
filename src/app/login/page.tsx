import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { isDevAuth } from "@/lib/config";
import { privilegedQuery } from "@/lib/db";
import { DevSignInForm, OtpSignInForm } from "./LoginForms";

interface DemoAccount {
  email: string;
  display_name: string;
}

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/dashboard");
  const devMode = isDevAuth();
  const demoAccounts = devMode
    ? await privilegedQuery<DemoAccount>(
        `select email, display_name from profiles
         where is_synthetic and email like 'demo.%@ui.ac.id' order by display_name`,
      )
    : [];

  return (
    <div className="mx-auto max-w-md space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Sign in to Lerne</h1>
        <p className="mt-1 text-sm text-slate-600">
          Teach an hour, earn an hour. Only <strong>@ui.ac.id</strong> campus emails can join.
        </p>
      </div>

      {devMode ? (
        <>
          <section className="rounded-lg border border-amber-300 bg-amber-50 p-4">
            <h2 className="font-medium text-amber-900">Dev sign-in bypass (local demo only)</h2>
            <p className="mt-1 text-xs text-amber-900">
              No email is sent and nothing is verified. Real deployments use Supabase email OTP
              (LERNE_AUTH_MODE=supabase).
            </p>
            <div className="mt-3">
              <DevSignInForm />
            </div>
          </section>

          {demoAccounts.length > 0 && (
            <section>
              <h2 className="text-sm font-medium text-slate-700">Synthetic demo accounts</h2>
              <ul className="mt-2 grid gap-2">
                {demoAccounts.map((a) => (
                  <li key={a.email}>
                    <DevSignInForm presetEmail={a.email} label={a.display_name} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      ) : (
        <OtpSignInForm />
      )}
    </div>
  );
}
