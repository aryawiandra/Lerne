"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { withUser } from "@/lib/db";
import { failure, type FormState } from "@/lib/errors";
import { parseMinute } from "@/lib/time";

const MAX_COURSES = 30;
const COURSE_CODE = /^[A-Z0-9-]{3,20}$/;

export async function saveCourses(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const codes = formData.getAll("course").map(String);
  if (codes.length > MAX_COURSES || codes.some((c) => !COURSE_CODE.test(c))) {
    return { error: "Invalid course selection." };
  }
  try {
    await withUser(user.id, async (c) => {
      await c.query("delete from tutor_courses where user_id = auth.uid()");
      if (codes.length > 0) {
        await c.query(
          "insert into tutor_courses (user_id, course_code) select auth.uid(), unnest($1::text[])",
          [codes],
        );
      }
    });
  } catch (error) {
    return failure(error);
  }
  revalidatePath("/profile");
  return { ok: codes.length ? `Saved ${codes.length} course(s) you can teach.` : "You are not listed as a tutor." };
}

const slotSchema = z
  .object({
    dayOfWeek: z.coerce.number().int().min(1).max(7),
    start: z.string().transform((v, ctx) => {
      const m = parseMinute(v);
      if (m === null) ctx.addIssue({ code: "custom", message: "Invalid start time" });
      return m ?? 0;
    }),
    end: z.string().transform((v, ctx) => {
      const m = parseMinute(v);
      if (m === null) ctx.addIssue({ code: "custom", message: "Invalid end time" });
      return m ?? 0;
    }),
  })
  .refine((s) => s.end > s.start, { message: "End time must be after start time" });

export async function addSlot(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const parsed = slotSchema.safeParse({
    dayOfWeek: formData.get("dayOfWeek"),
    start: formData.get("start"),
    end: formData.get("end"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    await withUser(user.id, (c) =>
      c.query(
        `insert into availability_slots (user_id, day_of_week, start_minute, end_minute)
         values (auth.uid(), $1, $2, $3) on conflict do nothing`,
        [parsed.data.dayOfWeek, parsed.data.start, parsed.data.end],
      ),
    );
  } catch (error) {
    return failure(error);
  }
  revalidatePath("/profile");
  return { ok: "Slot added." };
}

export async function deleteSlot(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const id = z.uuid().safeParse(formData.get("slotId"));
  if (!id.success) return { error: "Invalid slot." };
  try {
    await withUser(user.id, (c) => c.query("delete from availability_slots where id = $1", [id.data]));
  } catch (error) {
    return failure(error);
  }
  revalidatePath("/profile");
  return { ok: "Slot removed." };
}
