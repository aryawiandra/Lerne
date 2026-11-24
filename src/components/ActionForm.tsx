"use client";

import { useActionState, type ReactNode } from "react";
import type { FormState } from "@/lib/errors";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

const VARIANTS = {
  primary: "bg-teal-700 text-white hover:bg-teal-800",
  secondary: "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50",
  danger: "border border-rose-300 bg-white text-rose-700 hover:bg-rose-50",
} as const;

interface Props {
  action: Action;
  submitLabel: string;
  pendingLabel?: string;
  variant?: keyof typeof VARIANTS;
  className?: string;
  children?: ReactNode;
}

export function ActionForm({ action, submitLabel, pendingLabel, variant = "primary", className, children }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className={className ?? "space-y-3"}>
      {children}
      <button
        type="submit"
        disabled={pending}
        className={`rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60 ${VARIANTS[variant]}`}
      >
        {pending ? (pendingLabel ?? "Working…") : submitLabel}
      </button>
      <FormMessage state={state} />
    </form>
  );
}

export function FormMessage({ state }: { state: FormState }) {
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-rose-700">
        {state.error}
      </p>
    );
  }
  if (state.ok) {
    return (
      <p role="status" className="text-sm text-teal-800">
        {state.ok}
      </p>
    );
  }
  return null;
}
