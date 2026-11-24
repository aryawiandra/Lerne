import { createRequest } from "@/app/actions/requests";
import { ActionForm } from "@/components/ActionForm";
import { Card } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getCourses, getCreditSummary } from "@/lib/queries";
import { tomorrowAtWibHour } from "@/lib/time";

const FIELD = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm";
const DEFAULT_HOUR = 14;

export default async function NewRequestPage() {
  const user = await requireUser();
  const [courses, credits] = await Promise.all([getCourses(user.id), getCreditSummary(user.id)]);
  const tomorrowAtTwo = tomorrowAtWibHour(DEFAULT_HOUR);

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">Ask for help</h1>
      <p className="text-sm text-slate-600">
        You have <strong>{credits.available}</strong> credit(s) available. Each hour costs 1 credit, paid to the tutor
        when the session ends.
      </p>
      <Card title="What do you need?">
        <ActionForm action={createRequest} submitLabel="Find tutors" pendingLabel="Matching…">
          <div className="text-sm">
            <label htmlFor="req-course" className="text-slate-600">Course</label>
            <select id="req-course" name="courseCode" required className={FIELD} defaultValue="">
              <option value="" disabled>
                Choose a course
              </option>
              {courses.map((c) => (
                <option key={c.code} value={c.code}>
                  Sem {c.semester} · {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="text-sm">
            <label htmlFor="req-topic" className="text-slate-600">Topic</label>
            <input
              id="req-topic"
              name="topic"
              required
              minLength={3}
              maxLength={200}
              placeholder="e.g. Recursion on linked lists"
              className={FIELD}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="text-sm">
              <label htmlFor="req-start" className="text-slate-600">Preferred time (WIB)</label>
              <input
                id="req-start"
                name="preferredStart"
                type="datetime-local"
                required
                defaultValue={tomorrowAtTwo}
                className={FIELD}
              />
            </div>
            <div className="text-sm">
              <label htmlFor="req-duration" className="text-slate-600">Duration</label>
              <select id="req-duration" name="durationHours" className={FIELD} defaultValue="1">
                <option value="1">1 hour</option>
                <option value="2">2 hours</option>
                <option value="3">3 hours</option>
              </select>
            </div>
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}
