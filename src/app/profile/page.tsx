import { addSlot, deleteSlot, saveCourses } from "@/app/actions/profile";
import { ActionForm } from "@/components/ActionForm";
import { Card } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getCourses, getMySlots, getMyTutorCourses } from "@/lib/queries";
import { DAY_NAMES, formatMinute } from "@/lib/time";

const SELECT = "rounded-md border border-slate-300 px-2 py-1.5 text-sm";

export default async function ProfilePage() {
  const user = await requireUser();
  const [courses, mine, slots] = await Promise.all([
    getCourses(user.id),
    getMyTutorCourses(user.id),
    getMySlots(user.id),
  ]);
  const teaching = new Set(mine);
  const semesters = [...new Set(courses.map((c) => c.semester))];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Teach</h1>
        <p className="text-sm text-slate-600">
          Pick the courses you can tutor and when you are usually free. Matching uses both.
        </p>
      </div>

      <Card title="Courses I can teach">
        <p className="mb-3 text-xs text-slate-500">
          Teknik Komputer UI, mandatory courses semesters 1–4 (draft list; codes are Lerne placeholders).
        </p>
        <ActionForm action={saveCourses} submitLabel="Save courses">
          <div className="grid gap-4 sm:grid-cols-2">
            {semesters.map((sem) => (
              <fieldset key={sem}>
                <legend className="text-sm font-medium">Semester {sem}</legend>
                {courses
                  .filter((c) => c.semester === sem)
                  .map((c) => (
                    <label key={c.code} className="mt-1 flex items-center gap-2 text-sm">
                      <input type="checkbox" name="course" value={c.code} defaultChecked={teaching.has(c.code)} />
                      {c.name}
                    </label>
                  ))}
              </fieldset>
            ))}
          </div>
        </ActionForm>
      </Card>

      <Card title="Weekly free slots (WIB)">
        {slots.length === 0 ? (
          <p className="mb-3 text-sm text-slate-500">No slots yet.</p>
        ) : (
          <ul className="mb-4 divide-y divide-slate-100">
            {slots.map((s) => (
              <li key={s.id} className="flex items-center justify-between py-2 text-sm">
                <span data-testid="slot">
                  {DAY_NAMES[s.dayOfWeek]} {formatMinute(s.startMinute)}–{formatMinute(s.endMinute)}
                </span>
                <ActionForm action={deleteSlot} submitLabel="Remove" variant="danger" className="flex gap-2">
                  <input type="hidden" name="slotId" value={s.id} />
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
        <ActionForm action={addSlot} submitLabel="Add slot" className="flex flex-wrap items-end gap-3">
          <div className="text-sm">
            <label htmlFor="slot-day" className="block text-slate-600">Day</label>
            <select id="slot-day" name="dayOfWeek" className={SELECT} defaultValue="1">
              {DAY_NAMES.slice(1).map((d, i) => (
                <option key={d} value={i + 1}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="text-sm">
            <label htmlFor="slot-start" className="block text-slate-600">From</label>
            <input id="slot-start" name="start" type="time" required defaultValue="13:00" className={SELECT} />
          </div>
          <div className="text-sm">
            <label htmlFor="slot-end" className="block text-slate-600">To</label>
            <input id="slot-end" name="end" type="time" required defaultValue="16:00" className={SELECT} />
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}
