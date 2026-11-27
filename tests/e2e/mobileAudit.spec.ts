// Automated mobile audit of the core flow: phone viewport, axe accessibility scan of every
// screen, layout overflow, small tap targets, and time + actions to send a request.
// This is an automated check, NOT a usability test with real students.
// Uses fresh SYNTHETIC accounts via the dev sign-in bypass. Writes test-results/mobile-audit.json.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { toWibLocalInput, toWibParts } from "../../src/lib/time";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONDAY = 1;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const MIN_TAP_PX = 24; // WCAG 2.2 SC 2.5.8 Target Size (Minimum)
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

type ScreenReport = {
  screen: string;
  axeViolations: { id: string; impact: string | null | undefined; nodes: number; help: string }[];
  horizontalOverflow: boolean;
  smallTapTargets: string[];
};

function nextMondayAtTwo(): string {
  let date = new Date(Date.now() + DAY_MS);
  while (toWibParts(date).dayOfWeek !== MONDAY) date = new Date(date.getTime() + DAY_MS);
  return `${toWibLocalInput(date).slice(0, 10)}T14:00`;
}

async function phonePage(browser: Browser): Promise<Page> {
  const context = await browser.newContext(PHONE);
  return context.newPage();
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Campus email").fill(email);
  await page.getByRole("button", { name: "Sign in (dev bypass)" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function audit(page: Page, screen: string): Promise<ScreenReport> {
  const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const layout = await page.evaluate((minTap) => {
    const overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    const small = Array.from(document.querySelectorAll("a, button, input, select, textarea, [role=button]"))
      .filter((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(el as HTMLElement);
        const hidden = r.width === 0 || r.height === 0 || style.visibility === "hidden";
        const inlineLink = el.tagName === "A" && style.display === "inline";
        return !hidden && !inlineLink && (r.width < minTap || r.height < minTap);
      })
      .map((el) => `${el.tagName.toLowerCase()}: ${(el.textContent || (el as HTMLInputElement).name || "").trim().slice(0, 40)}`);
    return { overflow, small };
  }, MIN_TAP_PX);
  return {
    screen,
    axeViolations: axe.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help })),
    horizontalOverflow: layout.overflow,
    smallTapTargets: layout.small,
  };
}

test("mobile audit of the core flow (automated, not a user test)", async ({ browser }) => {
  const stamp = Date.now();
  const tutorName = `audit.tutor.${stamp}`;
  const reports: ScreenReport[] = [];

  const learner = await phonePage(browser);
  await learner.goto("/login");
  reports.push(await audit(learner, "Sign in"));

  const tutor = await phonePage(browser);
  await signIn(tutor, `${tutorName}@ui.ac.id`);
  await tutor.goto("/profile");
  reports.push(await audit(tutor, "Profile"));
  await tutor.getByLabel("Kalkulus 2", { exact: true }).check(); // course not used by coreFlow.spec.ts
  await tutor.getByRole("button", { name: "Save courses" }).click();
  await expect(tutor.getByText("Saved 1 course(s) you can teach.")).toBeVisible();
  await tutor.getByLabel("Day", { exact: true }).selectOption({ label: "Monday" });
  await tutor.getByLabel("From", { exact: true }).fill("13:00");
  await tutor.getByLabel("To", { exact: true }).fill("17:00");
  await tutor.getByRole("button", { name: "Add slot" }).click();
  await expect(tutor.getByTestId("slot")).toHaveText("Monday 13:00–17:00");

  // Time and actions from opening the sign-in page to seeing suggested tutors.
  const started = Date.now();
  let actions = 0;
  await learner.goto("/login");
  await learner.getByLabel("Campus email").fill(`audit.learner.${stamp}@ui.ac.id`); actions++;
  await learner.getByRole("button", { name: "Sign in (dev bypass)" }).click(); actions++;
  await expect(learner).toHaveURL(/\/dashboard$/);
  reports.push(await audit(learner, "Dashboard"));
  await learner.goto("/requests/new"); actions++;
  reports.push(await audit(learner, "Ask for help"));
  await learner.getByLabel("Course", { exact: true }).selectOption({ label: "Sem 2 · Kalkulus 2" }); actions++;
  await learner.getByLabel("Topic", { exact: true }).fill("Integration by parts"); actions++;
  await learner.getByLabel("Preferred time (WIB)").fill(nextMondayAtTwo()); actions++;
  await learner.getByRole("button", { name: "Find tutors" }).click(); actions++;
  await expect(learner.getByTestId("suggestion").first()).toBeVisible();
  const machineMsToSuggestions = Date.now() - started;
  reports.push(await audit(learner, "Suggested tutors"));

  await learner.getByRole("button", { name: `Ask ${tutorName}` }).click(); actions++;
  await expect(learner.getByText("Waiting for the tutor")).toBeVisible();
  await tutor.goto("/dashboard");
  await tutor.getByRole("button", { name: "Accept" }).click();
  await expect(tutor).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/);
  await tutor.getByRole("button", { name: "Show start QR" }).click();
  await expect(tutor.getByAltText("Session start QR code")).toBeVisible();
  reports.push(await audit(tutor, "Session (tutor, start code)"));
  const sessionPath = new URL(tutor.url()).pathname;
  await learner.goto(sessionPath);
  reports.push(await audit(learner, "Session (learner)"));

  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/mobile-audit.json",
    JSON.stringify(
      {
        note: "Automated audit with SYNTHETIC accounts on a 390x844 phone viewport. Not a usability test with real students.",
        ranAt: new Date().toISOString(),
        viewport: PHONE.viewport,
        axeTags: AXE_TAGS,
        minTapPx: MIN_TAP_PX,
        requestFlow: { userActionsToSendRequest: actions, machineMsToSuggestions },
        screens: reports,
      },
      null,
      2,
    ),
  );
  expect(reports.length).toBe(7);
});
