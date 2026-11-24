import type { ReactNode } from "react";

export function Card({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const STATUS_STYLES: Record<string, string> = {
  open: "bg-sky-50 text-sky-800",
  pending: "bg-amber-50 text-amber-800",
  accepted: "bg-teal-50 text-teal-800",
  scheduled: "bg-teal-50 text-teal-800",
  in_progress: "bg-indigo-50 text-indigo-800",
  completed: "bg-slate-100 text-slate-700",
  cancelled: "bg-rose-50 text-rose-700",
};

const STATUS_LABELS: Record<string, string> = {
  open: "Choosing tutor",
  pending: "Waiting for tutor",
  accepted: "Accepted",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      data-testid="status"
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status] ?? "bg-slate-100"}`}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
