import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { assignTutor, cancelRequest, respondToRequest } from "@/app/actions/requests";
import { ActionForm } from "@/components/ActionForm";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Card, StatusBadge } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import type { RankedTutor } from "@/lib/matching";
import { getRequest, getSuggestions } from "@/lib/queries";
import { formatWib } from "@/lib/time";

export default async function RequestPage(props: PageProps<"/requests/[id]">) {
  const user = await requireUser();
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) notFound();
  const request = await getRequest(user.id, id);
  if (!request) notFound();

  const isLearner = request.learnerId === user.id;
  const suggestions = isLearner && request.status === "open" ? await getSuggestions(user.id, request) : [];

  return (
    <div className="space-y-6">
      <AutoRefresh />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{request.courseName}</h1>
          <p className="text-slate-700">{request.topic}</p>
          <p className="text-sm text-slate-500">
            {formatWib(request.preferredStart)} · {request.durationHours} h · costs {request.durationHours} credit(s)
          </p>
        </div>
        <StatusBadge status={request.status} />
      </div>

      {isLearner && request.status === "open" && (
        <Card title="Suggested tutors">
          <p className="mb-3 text-xs text-slate-500">
            Ranked by: teaches this course → free-slot overlap with your time → rating (new tutors count as 3.0).
            Up to 3 shown.
          </p>
          {suggestions.length === 0 ? (
            <p className="text-sm text-slate-600">
              No eligible tutor for this course right now. Try another time or course.
            </p>
          ) : (
            <ol className="space-y-3">
              {suggestions.map((t, i) => (
                <li key={t.tutorId} data-testid="suggestion" className="rounded-md border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm">
                      <p className="font-medium">
                        {i + 1}. {t.displayName}
                      </p>
                      <MatchReasons tutor={t} durationHours={request.durationHours} />
                    </div>
                    <ActionForm action={assignTutor} submitLabel={`Ask ${t.displayName}`} className="flex gap-2">
                      <input type="hidden" name="requestId" value={request.id} />
                      <input type="hidden" name="tutorId" value={t.tutorId} />
                    </ActionForm>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>
      )}

      {request.status === "pending" && isLearner && (
        <Card title="Waiting for the tutor">
          <p className="text-sm">
            Sent to <strong>{request.tutorName}</strong>. This page refreshes automatically.
          </p>
        </Card>
      )}

      {request.status === "pending" && request.tutorId === user.id && (
        <Card title={`${request.learnerName} asked you for help`}>
          <div className="flex gap-2">
            <ActionForm action={respondToRequest} submitLabel="Accept" className="flex gap-2">
              <input type="hidden" name="requestId" value={request.id} />
              <input type="hidden" name="decision" value="accept" />
            </ActionForm>
            <ActionForm action={respondToRequest} submitLabel="Decline" variant="secondary" className="flex gap-2">
              <input type="hidden" name="requestId" value={request.id} />
              <input type="hidden" name="decision" value="decline" />
            </ActionForm>
          </div>
        </Card>
      )}

      {request.sessionId && (
        <Link href={`/sessions/${request.sessionId}`} className="inline-block text-teal-800 underline">
          Go to the session →
        </Link>
      )}

      {isLearner && (request.status === "open" || request.status === "pending") && (
        <ActionForm action={cancelRequest} submitLabel="Cancel request" variant="danger">
          <input type="hidden" name="requestId" value={request.id} />
        </ActionForm>
      )}
    </div>
  );
}

function MatchReasons({ tutor, durationHours }: { tutor: RankedTutor; durationHours: number }) {
  const overlap = tutor.coversWholeWindow
    ? "Free for your whole time window"
    : tutor.overlapMinutes > 0
      ? `Free for ${tutor.overlapMinutes} of ${durationHours * 60} min`
      : "No matching free slot — you may need to agree on a time";
  const rating =
    tutor.ratingAvg === null ? "New tutor (no ratings yet)" : `★ ${tutor.ratingAvg.toFixed(1)} (${tutor.ratingCount})`;
  return (
    <p className="text-slate-600">
      {overlap} · {rating}
    </p>
  );
}
