"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { rows, withUser } from "@/lib/db";
import { failure, type FormState } from "@/lib/errors";
import { parseWibLocalInput } from "@/lib/time";

const requestSchema = z.object({
  courseCode: z.string().regex(/^[A-Z0-9-]{3,20}$/, "Choose a course"),
  topic: z.string().trim().min(3, "Describe the topic (at least 3 characters)").max(200),
  preferredStart: z.string().transform((v, ctx) => {
    const date = parseWibLocalInput(v);
    if (!date) ctx.addIssue({ code: "custom", message: "Choose a preferred date and time" });
    return date ?? new Date(0);
  }),
  durationHours: z.coerce.number().int().min(1).max(3),
});

export async function createRequest(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const parsed = requestSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  let requestId: string;
  try {
    const [row] = await withUser(user.id, (c) =>
      rows<{ id: string }>(c, "select create_help_request($1, $2, $3, $4) as id", [
        parsed.data.courseCode,
        parsed.data.topic,
        parsed.data.preferredStart,
        parsed.data.durationHours,
      ]),
    );
    requestId = row.id;
  } catch (error) {
    return failure(error);
  }
  redirect(`/requests/${requestId}`);
}

const idsSchema = z.object({ requestId: z.uuid(), tutorId: z.uuid().optional() });

export async function assignTutor(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const parsed = idsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success || !parsed.data.tutorId) return { error: "Invalid selection." };
  try {
    await withUser(user.id, (c) => c.query("select assign_tutor($1, $2)", [parsed.data.requestId, parsed.data.tutorId]));
  } catch (error) {
    return failure(error);
  }
  revalidatePath(`/requests/${parsed.data.requestId}`);
  return { ok: "Request sent to tutor." };
}

export async function cancelRequest(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const parsed = idsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Invalid request." };
  try {
    await withUser(user.id, (c) => c.query("select cancel_help_request($1)", [parsed.data.requestId]));
  } catch (error) {
    return failure(error);
  }
  revalidatePath("/dashboard");
  revalidatePath(`/requests/${parsed.data.requestId}`);
  return { ok: "Request cancelled; reserved credits released." };
}

export async function respondToRequest(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const parsed = idsSchema.safeParse({ requestId: formData.get("requestId") });
  const accept = formData.get("decision") === "accept";
  if (!parsed.success) return { error: "Invalid request." };

  let sessionId: string | null;
  try {
    const [row] = await withUser(user.id, (c) =>
      rows<{ id: string | null }>(c, "select respond_to_request($1, $2) as id", [parsed.data.requestId, accept]),
    );
    sessionId = row.id;
  } catch (error) {
    return failure(error);
  }
  revalidatePath("/dashboard");
  if (sessionId) redirect(`/sessions/${sessionId}`);
  return { ok: "Declined. The learner can pick another tutor." };
}
