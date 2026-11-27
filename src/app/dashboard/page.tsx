import Link from "next/link";
import { respondToRequest } from "@/app/actions/requests";
import { ActionForm } from "@/components/ActionForm";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Card, StatusBadge } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { claimSafetyNet, getCreditSummary, getSafetyNetStatus, getIncomingRequests, getLedger, getMyRequests, getMySessions } from "@/lib/queries";
import { formatWib } from "@/lib/time";

const REASON_LABELS: Record<string, string> = {
  signup_grant: "Welcome credits",
  session_taught: "Taught",
  session_learned: "Learned",
  demo_adjustment: "Demo adjustment (synthetic)",
  safety_net_grant: "Safety-net credit",
};

export default async function DashboardPage() {
  const user = await requireUser();
  await claimSafetyNet(user.id); // before reading the balance (idempotent; the layout also claims)
  const [safetyNet, credits, incoming, sessions, requests, ledger] = await Promise.all([
    getSafetyNetStatus(user.id),
    getCreditSummary(user.id),
    getIncomingRequests(user.id),
    getMySessions(user.id),
    getMyRequests(user.id),
    getLedger(user.id),
  ]);

  return (
    <div className="space-y-6">
      <AutoRefresh intervalMs={6000} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Hi, {user.displayName}</h1>
          <p className="text-sm text-slate-600">1 hour taught = +1 credit · 1 hour learned = −1 credit</p>
        </div>
        <Link href="/requests/new" className="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white">
          Ask for help
        </Link>
      </div>

      {safetyNet.grantedThisWeek && (
        <p data-testid="safety-net" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          You were at 0 credits, so Lerne added 1 safety-net credit this week
          ({safetyNet.usedThisSemester} of {safetyNet.maxPerSemester} this semester). Teaching a course you are
          strong in earns credits back.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Balance" value={credits.balance} testId="balance" />
        <Stat label="Reserved by open requests" value={credits.reserved} />
        <Stat label="Available to spend" value={credits.available} />
      </div>

      <Card title="Requests waiting for you (as tutor)">
        {incoming.length === 0 ? (
          <Empty>No pending requests. Add courses and free slots on the Teach page to get matched.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {incoming.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="text-sm">
                  <p className="font-medium">
                    {r.courseName}: {r.topic}
                  </p>
                  <p className="text-slate-600">
                    {r.learnerName} · {formatWib(r.preferredStart)} · {r.durationHours} h
                  </p>
                </div>
                <div className="flex gap-2">
                  <ActionForm action={respondToRequest} submitLabel="Accept" className="flex gap-2">
                    <input type="hidden" name="requestId" value={r.id} />
                    <input type="hidden" name="decision" value="accept" />
                  </ActionForm>
                  <ActionForm action={respondToRequest} submitLabel="Decline" variant="secondary" className="flex gap-2">
                    <input type="hidden" name="requestId" value={r.id} />
                    <input type="hidden" name="decision" value="decline" />
                  </ActionForm>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Sessions">
        {sessions.length === 0 ? (
          <Empty>No sessions yet.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div>
                  <Link href={`/sessions/${s.id}`} className="font-medium text-teal-800 underline">
                    {s.courseName}: {s.topic}
                  </Link>
                  <p className="text-slate-600">
                    {s.tutorId === user.id ? `You teach ${s.learnerName}` : `${s.tutorName} teaches you`} ·{" "}
                    {formatWib(s.scheduledStart)} · {s.durationHours} h
                  </p>
                </div>
                <StatusBadge status={s.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Your help requests">
        {requests.length === 0 ? (
          <Empty>You have not asked for help yet.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {requests.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <Link href={`/requests/${r.id}`} className="font-medium text-teal-800 underline">
                  {r.courseName}: {r.topic}
                </Link>
                <StatusBadge status={r.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Credit ledger (append-only)">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-1 font-normal">When</th>
              <th className="py-1 font-normal">What</th>
              <th className="py-1 text-right font-normal">Credits</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((e) => (
              <tr key={e.id} className="border-t border-slate-100">
                <td className="py-1.5">{formatWib(e.createdAt)}</td>
                <td className="py-1.5">
                  {REASON_LABELS[e.reason] ?? e.reason}
                  {e.counterpartyName ? ` · ${e.counterpartyName}` : ""}
                </td>
                <td className={`py-1.5 text-right font-medium ${e.delta > 0 ? "text-teal-800" : "text-rose-700"}`}>
                  {e.delta > 0 ? `+${e.delta}` : e.delta}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function Stat({ label, value, testId }: { label: string; value: number; testId?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p data-testid={testId} className="mt-1 text-2xl font-semibold">
        {value}
      </p>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-slate-500">{children}</p>;
}
