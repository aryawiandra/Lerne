// Core user flow, end to end through the real UI, two browsers (tutor + learner).
// Uses fresh SYNTHETIC accounts created via the dev sign-in bypass.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { toWibLocalInput, toWibParts } from "../../src/lib/time";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONDAY = 1;

/** Next Monday (at least tomorrow) 14:00 WIB as a datetime-local value. */
function nextMondayAtTwo(): string {
  let date = new Date(Date.now() + DAY_MS);
  while (toWibParts(date).dayOfWeek !== MONDAY) date = new Date(date.getTime() + DAY_MS);
  return `${toWibLocalInput(date).slice(0, 10)}T14:00`;
}

async function signedInPage(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Campus email").fill(email);
  await page.getByRole("button", { name: "Sign in (dev bypass)" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return page;
}

test("learner gets help from a matched tutor; QR start/end moves credits; both rate", async ({ browser }) => {
  const stamp = Date.now();
  const tutorName = `e2e.tutor.${stamp}`;
  const learnerName = `e2e.learner.${stamp}`;

  // 1. Sign in with campus emails (non-campus email is rejected)
  const rejected = await (await browser.newContext()).newPage();
  await rejected.goto("/login");
  await rejected.getByLabel("Campus email").fill("someone@gmail.com");
  await rejected.getByRole("button", { name: "Sign in (dev bypass)" }).click();
  await expect(rejected.getByText("Use your @ui.ac.id campus email.")).toBeVisible();

  const tutor = await signedInPage(browser, `${tutorName}@ui.ac.id`);
  const learner = await signedInPage(browser, `${learnerName}@ui.ac.id`);
  await expect(learner.getByTestId("balance")).toHaveText("2");

  // 2. Tutor profile: course + weekly slot
  await tutor.goto("/profile");
  await tutor.getByLabel("Struktur Data dan Algoritma").check();
  await tutor.getByRole("button", { name: "Save courses" }).click();
  await expect(tutor.getByText("Saved 1 course(s) you can teach.")).toBeVisible();
  await tutor.getByLabel("Day", { exact: true }).selectOption({ label: "Monday" });
  await tutor.getByLabel("From", { exact: true }).fill("13:00");
  await tutor.getByLabel("To", { exact: true }).fill("17:00");
  await tutor.getByRole("button", { name: "Add slot" }).click();
  await expect(tutor.getByTestId("slot")).toHaveText("Monday 13:00–17:00");

  // 3. Learner requests help
  await learner.goto("/requests/new");
  await learner.getByLabel("Course", { exact: true }).selectOption({ label: "Sem 3 · Struktur Data dan Algoritma" });
  await learner.getByLabel("Topic", { exact: true }).fill("Recursion on linked lists");
  await learner.getByLabel("Preferred time (WIB)").fill(nextMondayAtTwo());
  await learner.getByRole("button", { name: "Find tutors" }).click();
  await expect(learner).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);

  // 4. Matching: up to 3 suggestions, our tutor among them
  const suggestions = learner.getByTestId("suggestion");
  await expect(suggestions).toHaveCount(3);
  await expect(suggestions.filter({ hasText: tutorName })).toContainText("Free for your whole time window");
  await learner.getByRole("button", { name: `Ask ${tutorName}` }).click();
  await expect(learner.getByText("Waiting for the tutor")).toBeVisible();

  // 5. Tutor accepts
  await tutor.goto("/dashboard");
  await tutor.getByRole("button", { name: "Accept" }).click();
  await expect(tutor).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/);
  const sessionPath = new URL(tutor.url()).pathname;

  // 6. QR start: tutor shows signed token, learner enters it
  await tutor.getByRole("button", { name: "Show start QR" }).click();
  await expect(tutor.getByAltText("Session start QR code")).toBeVisible();
  const startToken = (await tutor.getByTestId("session-token").innerText()).trim();

  await learner.goto(sessionPath);
  await learner.getByLabel("Session code").fill(startToken);
  await learner.getByRole("button", { name: "Start session" }).click();
  await expect(learner.getByTestId("status")).toHaveText("In progress");

  // ... and QR end
  await expect(tutor.getByRole("button", { name: "Show end QR" })).toBeVisible(); // via auto-refresh
  await tutor.getByRole("button", { name: "Show end QR" }).click();
  const endToken = (await tutor.getByTestId("session-token").innerText()).trim();
  expect(endToken).not.toBe(startToken);
  await learner.getByLabel("Session code").fill(endToken);
  await learner.getByRole("button", { name: "End session" }).click();
  await expect(learner.getByTestId("credits-transferred")).toContainText("1 credit(s) moved");

  // 7. Credits: learner 2 → 1, tutor 2 → 3
  await learner.goto("/dashboard");
  await expect(learner.getByTestId("balance")).toHaveText("1");
  await tutor.goto("/dashboard");
  await expect(tutor.getByTestId("balance")).toHaveText("3");

  // 8. Both rate
  for (const [page, score] of [
    [learner, "5"],
    [tutor, "4"],
  ] as const) {
    await page.goto(sessionPath);
    await page.getByLabel(score, { exact: true }).check();
    await page.getByRole("button", { name: "Submit rating" }).click();
    await expect(page.getByText(/You rated/)).toBeVisible();
  }
});
