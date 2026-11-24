"use client";

import { useActionState } from "react";
import { devSignIn, sendOtp, verifyOtp, type OtpState } from "@/app/actions/auth";
import { FormMessage } from "@/components/ActionForm";

const INPUT = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm";
const BUTTON = "rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-60";

export function DevSignInForm({ presetEmail, label }: { presetEmail?: string; label?: string }) {
  const [state, action, pending] = useActionState(devSignIn, {});
  if (presetEmail) {
    return (
      <form action={action}>
        <input type="hidden" name="email" value={presetEmail} />
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-left text-sm hover:border-teal-600"
        >
          <span className="font-medium">{label}</span>{" "}
          <span className="text-slate-500">{presetEmail}</span>
        </button>
        <FormMessage state={state} />
      </form>
    );
  }
  return (
    <form action={action} className="space-y-2">
      <label className="block text-sm" htmlFor="dev-email">
        Campus email
      </label>
      <input id="dev-email" name="email" type="email" required placeholder="nama@ui.ac.id" className={INPUT} />
      <button type="submit" disabled={pending} className={BUTTON}>
        {pending ? "Signing in…" : "Sign in (dev bypass)"}
      </button>
      <FormMessage state={state} />
    </form>
  );
}

export function OtpSignInForm() {
  const [sent, sendAction, sending] = useActionState<OtpState, FormData>(sendOtp, {});
  const [verified, verifyAction, verifying] = useActionState<OtpState, FormData>(verifyOtp, {});

  if (!sent.ok) {
    return (
      <form action={sendAction} className="space-y-2">
        <label className="block text-sm" htmlFor="otp-email">
          Campus email
        </label>
        <input id="otp-email" name="email" type="email" required placeholder="nama@ui.ac.id" className={INPUT} />
        <button type="submit" disabled={sending} className={BUTTON}>
          {sending ? "Sending…" : "Email me a code"}
        </button>
        <FormMessage state={sent} />
      </form>
    );
  }
  return (
    <form action={verifyAction} className="space-y-2">
      <p className="text-sm text-teal-800">{sent.ok}</p>
      <input type="hidden" name="email" value={sent.email} />
      <label className="block text-sm" htmlFor="otp-token">
        6-digit code
      </label>
      <input id="otp-token" name="token" inputMode="numeric" pattern="\d{6}" required className={INPUT} />
      <button type="submit" disabled={verifying} className={BUTTON}>
        {verifying ? "Checking…" : "Sign in"}
      </button>
      <FormMessage state={verified} />
    </form>
  );
}
