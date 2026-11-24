import { notFound } from "next/navigation";
import { z } from "zod";
import { rateSession } from "@/app/actions/sessions";
import { ActionForm } from "@/components/ActionForm";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Card, StatusBadge } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getSession } from "@/lib/queries";
import { formatWib } from "@/lib/time";
import { QrPanel, RedeemPanel } from "./SessionPanels";

export default async function SessionPage(props: PageProps<"/sessions/[id]">) {
  const user = await requireUser();
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) notFound();
  const session = await getSession(user.id, id);
  if (!session) notFound();

  const isTutor = session.tutorId === user.id;
  const other = isTutor ? session.learnerName : session.tutorName;
  const phase = session.status === "scheduled" ? "start" : session.status === "in_progress" ? "end" : null;

  return (
    <div className="space-y-6">
      {session.status !== "completed" && <AutoRefresh />}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{session.courseName}</h1>
          <p className="text-slate-700">{session.topic}</p>
          <p className="text-sm text-slate-500">
            {isTutor ? `You are tutoring ${other}` : `${other} is tutoring you`} · {formatWib(session.scheduledStart)} ·{" "}
            {session.durationHours} h
          </p>
        </div>
        <StatusBadge status={session.status} />
      </div>

      {phase && isTutor && (
        <Card title={phase === "start" ? "Start the session" : "End the session"}>
          <p className="mb-3 text-sm text-slate-600">
            Show this QR code to {other}. It is signed by the server and expires after 2 minutes.
          </p>
          <QrPanel key={phase} sessionId={session.id} phase={phase} />
        </Card>
      )}

      {phase && !isTutor && (
        <Card title={phase === "start" ? "Start the session" : "End the session"}>
          <p className="mb-3 text-sm text-slate-600">
            Scan {other}&apos;s QR code, or paste the code shown under it.
            {phase === "end" && ` Ending transfers ${session.durationHours} credit(s) to ${other}.`}
          </p>
          <RedeemPanel key={phase} sessionId={session.id} phase={phase} />
        </Card>
      )}

      {session.status === "completed" && (
        <Card title="Session complete">
          <p className="text-sm" data-testid="credits-transferred">
            {session.creditsTransferred} credit(s) moved from {session.learnerName} to {session.tutorName}.
          </p>
          <div className="mt-4">
            {session.myRating ? (
              <p className="text-sm text-slate-600">You rated {other}: {"★".repeat(session.myRating)}</p>
            ) : (
              <ActionForm action={rateSession} submitLabel="Submit rating" className="flex flex-wrap items-center gap-3">
                <input type="hidden" name="sessionId" value={session.id} />
                <fieldset className="flex gap-3 text-sm">
                  <legend className="mb-1 w-full text-slate-600">Rate {other} (1–5)</legend>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <label key={n} className="flex items-center gap-1">
                      <input type="radio" name="score" value={n} required /> {n}
                    </label>
                  ))}
                </fieldset>
              </ActionForm>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
