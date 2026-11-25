# Lerne — peer-tutoring time bank (prototype)

Lerne lets Universitas Indonesia students trade tutoring by the hour: teach one hour and earn 1 credit, learn for one hour and spend 1 credit. Built by Team Conding (Teknik Komputer UI 2023) for STACK 2026, Case 1: Smarter Campus and Learning.

> **Status: working prototype, not production.** All accounts and data in the demo are **synthetic**.
> The core flow runs end to end on a **local Postgres fallback** (see "How it runs").
> The Supabase-hosted mode is implemented but **has not been run against a live Supabase project**.

---

## How it runs (and why)

The build machine had no Docker and no Supabase CLI, so local Supabase was not possible. The app is therefore built so that **the same SQL migration runs on both**:

| Mode | Database | Sign-in | Verified? |
|---|---|---|---|
| **Local demo** (`LERNE_AUTH_MODE=dev`) | Plain local Postgres (tested on 14.17) + a small shim (`db/local/00_supabase_shim.sql`) that provides Supabase's `auth.users`, `auth.uid()` and the `anon`/`authenticated` roles | **Dev sign-in bypass**: type any `@ui.ac.id` address or pick a synthetic demo account. **No email is sent and nothing is verified.** A banner on every page says so. | ✅ Yes: unit, DB and e2e tests, plus a manual run |
| **Supabase** (`LERNE_AUTH_MODE=supabase`) | Supabase Postgres via `DATABASE_URL` | Supabase Auth email OTP (6-digit code), restricted to `@ui.ac.id` | ⚠️ Code written; **not tested** against a real project |

In both modes, every user query runs inside a transaction as Postgres role `authenticated`, with the user's id in `request.jwt.claims`. That is the same mechanism Supabase's API uses, so **Row Level Security and all credit rules are enforced by the database itself**, not just by the UI (`src/lib/dbTx.ts`).

## Quick start (local demo)

Requirements: Node 20.9+ (tested on 22.15) and a local PostgreSQL 13+ that your OS user can create databases on.

```bash
npm install
cp .env.example .env.local
# put a random value in LERNE_SESSION_SECRET:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm run db:setup     # (re)creates lerne_dev: shim + migration + course list + SYNTHETIC seed
npm run dev          # http://localhost:3000
```

Demo script (two browser windows, e.g. one normal and one private):
1. Window A: sign in as **Bima (demo learner)**. Go to *Ask for help*, pick *Struktur Data dan Algoritma*, set a **Monday 14:00** time, then *Find tutors*. You should see Citra → Alya → Dimas and why each was suggested.
2. Click *Ask Citra (demo)*.
3. Window B: sign in as **Citra (demo)**. On the Dashboard click *Accept*, then *Show start QR*.
4. Window A: open the session (Dashboard → Sessions) and paste the code shown under the QR. The session starts.
5. Window B: *Show end QR*. Window A: paste it. 1 credit moves (Bima 2 → 1, Citra → +1).
6. Both rate the session (1–5).

`npm run db:setup` refuses to run against any non-localhost database.

## Supabase setup (untested)

1. Create a Supabase project and enable the Email provider. Set the email template to send the **OTP code** (`{{ .Token }}`).
2. Run `supabase/migrations/0001_init.sql`, then `supabase/seed/courses.sql`, in the SQL editor (or with `supabase db push`). **Do not** run `db/local/00_supabase_shim.sql` on Supabase.
3. `.env.local`: `LERNE_AUTH_MODE=supabase`, `DATABASE_URL` = the project's Postgres connection string (direct or session pooler), plus `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
4. Synthetic demo users can be added with `scripts/seed.ts` (it inserts into `auth.users`). Not tested on Supabase.

The migration revokes Supabase's default grants and exposes only a fixed set of functions to `authenticated`. Because PostgREST would expose those functions too, every rule lives inside them; calling the API directly bypasses nothing.

---

## What works end to end (verified)

Each item below is exercised by the Playwright test (`tests/e2e/coreFlow.spec.ts`) through the real UI with two browser contexts, and/or by the DB tests against a real Postgres.

1. **Campus sign-in.** Only `@ui.ac.id` addresses are accepted, checked in the app *and* by a trigger on `auth.users` (non-campus sign-ups are rejected by the database). Local mode uses the labelled dev bypass.
2. **Profile.** Pick courses you can teach from a seeded list of Teknik Komputer UI mandatory courses (semesters 1–4) and add/remove weekly free slots (WIB).
3. **Request help.** Course, topic, preferred time and 1–3 hours. Credits for open requests are *reserved*, so a learner cannot over-commit.
4. **Matching.** Plain rules, no AI (`src/lib/matching.ts`), up to 3 suggestions:
   - eligible = teaches the course, is not the learner, has not declined this request, and is under the weekly pair cap;
   - ranked by minutes of overlap between the requested window and the tutor's free slots → average rating (unrated tutors count as 3.0) → number of ratings → name.
   Each suggestion shows why it was ranked where it is.
5. **Tutor accepts or declines.** Declining reopens the request, and that tutor is excluded from that request's future suggestions.
6. **Session QR.** The tutor gets a token signed **inside Postgres** with HMAC-SHA256: `<session>.<start|end>.<expiry>.<sig>`. The key sits in `private.app_secrets` and is never readable by clients. Tokens are valid for 120 s and are rendered as a QR code. The learner pastes the code (or scans it, see limitations) to start, and again to end. Tampered, expired, wrong-user and out-of-order tokens are rejected (tested).
7. **Credits** (`credit_ledger`, append-only):
   - new users start with **2 credits** (signup trigger);
   - ending a session posts **−h to the learner and +h to the tutor** in the same transaction;
   - **balance can never go negative.** A constraint trigger checks every insert while holding a row lock on the user. If settlement would go negative, the whole end-of-session transaction rolls back (tested);
   - **weekly pair cap = 3 credits** per tutor-learner pair (Mon–Sun, WIB), enforced when a tutor is chosen, at acceptance, *and* by the ledger trigger;
   - ledger rows cannot be updated, deleted or truncated, not even by the table owner (tested).
8. **Ratings.** Both sides rate 1–5, once each, only after completion. The average rating feeds matching (tested).
9. **Row Level Security on every table** (asserted by a test that scans `pg_class`). Users read only their own ledger, requests and sessions; other users' email addresses are not readable (column-level grant). Writes to requests, sessions, ledger and ratings go only through `security definer` functions that check `auth.uid()`.

## Simulated, stubbed or unfinished

- **Dev sign-in bypass** (local mode): no email verification. Accounts created this way are flagged `is_synthetic`.
- **Supabase mode**: implemented, never run against a live project.
- **Seed data is synthetic**: 7 fictional `demo.*@ui.ac.id` accounts named "… (demo)". Their rating history comes from 4 sessions run through the real SQL functions at seed time. It is not real usage. Ledger rows with reason `demo_adjustment` exist only in tests.
- **Course catalogue**: course names and semesters were drafted from general knowledge and **must be checked against the official curriculum**. Codes (`TK1-01`…) are Lerne placeholders, not official UI codes. University-wide general courses are excluded.
- **Camera QR scanning**: uses the browser `BarcodeDetector` API where available (labelled "experimental"). Only the paste-the-code path is tested; camera scanning has not been tested on phones.
- **Real-time updates**: the session, request and dashboard pages poll every 4–6 s. There are no notifications.

## Known limitations

- Credits use the **booked** duration (1–3 h), not measured time between the start and end scans.
- Free slots cannot cross midnight; a requested window that runs past midnight is clipped when computing overlap.
- All times are WIB (Asia/Jakarta); there is no multi-timezone support.
- If a learner's balance drops after a session is accepted (only possible through an admin adjustment), the end scan fails and the session stays "in progress". There is no dispute or cancellation flow for accepted sessions yet.
- No admin UI, no rate limiting on server actions, no account deletion or data export flow.
- Profiles (display names) are visible to all signed-in users; emails are not.
- Not tested on mobile layouts beyond basic responsive Tailwind classes. No accessibility audit has been done.

## Deliberately left for Final Day (not built)

These need real design work and are intentionally **not** implemented, so they can be built at the 16 Dec Final Day:

1. **Reputation and abuse review.** Flag tutor-learner pairs that repeatedly hit the weekly cap or always rate each other 5, and send them to a review queue.
2. **Notifications and expiry.** Email when a request is made, accepted or about to expire (replacing today's page polling), plus automatic hand-off to the next tutor after 12 hours without a response.
3. **Teaching record.** A verifiable page showing a tutor's completed hours by course.

### Planned rules (from the credit simulation; not built yet)

- **Safety-net credit:** +1 credit at the start of a week when a user's balance is 0, max 6 per semester.
- **Fall-through on decline:** offer the request to up to 8 qualified tutors in turn, instead of only the top 3 suggestions.
- **Tutor load limit:** max 2 sessions per tutor per week.
- **Measured-time settlement:** settle by the time between the start and end scans, with a minimum session length (today credits use the booked duration).

### Later (out of scope for this competition)

- **Cross-faculty course catalogue.** The schema covers a single programme (`courses.program` defaults to Teknik Komputer). Needed: a faculty/programme model, course equivalences across programmes, an import path for official curriculum data, and matching that understands equivalent courses.

---

## Tests

```bash
npm run test:unit   # 31 tests: matching rules, campus-email check, dev-session cookie, WIB time helpers
npm run test:db     # 26 tests on a throwaway local Postgres DB: credit rules, RLS, QR tokens, ratings
npm run test        # both (57)
npm run test:e2e    # Playwright: full core flow in two browsers (rebuilds the lerne_e2e DB first)
npm run lint && npm run typecheck
```

Results on the build machine (24 Nov 2026, Postgres 14.17, Node 22.15): **57/57 vitest passed; e2e 1/1 passed (2 consecutive runs); lint and typecheck clean; `next build` succeeds.**

DB tests need a local Postgres. Set `TEST_DATABASE_URL` (default `postgresql://localhost:5432/postgres`, used only to create `lerne_test_*` databases) and `E2E_DATABASE_URL` (default `postgresql://localhost:5432/lerne_e2e`) if yours differ.

## Project layout

```
supabase/migrations/0001_init.sql   schema, RLS, credit + session + matching SQL functions
supabase/seed/courses.sql           course catalogue (to be verified)
db/local/00_supabase_shim.sql       LOCAL ONLY: emulates auth.users / auth.uid() / roles
db/sql.ts, db/flows.ts              build a DB from the SQL; drive the SQL API as users
scripts/dbSetup.ts, scripts/seed.ts local DB reset + SYNTHETIC demo data
src/lib/                            config, db access (RLS), auth, matching, time helpers
src/app/                            pages + server actions (Next.js 16 App Router)
tests/unit, tests/db, tests/e2e     vitest unit, vitest+Postgres, Playwright
```

## AI assistance

This prototype's code was generated by **Claude Code** (Anthropic's AI coding agent), working from the team's specification: core flow, credit rules, stack and test requirements. That includes the SQL schema and functions, the Next.js app, the seed and the tests. The AI also chose the local-Postgres fallback when Docker and the Supabase CLI turned out to be unavailable. Test results above are from actual runs, not estimates. The team is responsible for reviewing, verifying (e.g. the course catalogue) and extending the code.

## Credit-economy simulation (SYNTHETIC)

`sim/credit_sim.py` is the agent-based simulation behind Section 6.1 of our STACK 2026 proposal: 50 synthetic students, a 16-week semester, 200 runs, fixed seed. Every input is an assumption (listed in the script and in `sim/results.json`); none of it is user data. Reproduce with `python3 sim/credit_sim.py > sim/results.json` (Python 3, standard library only).

## Third-party resources

All used under their own open-source licences; no paid service, dataset or ready-made application is used.

| Package | Role | Licence |
|---|---|---|
| Next.js 16, React 19 | App framework and UI | MIT |
| Tailwind CSS 4 | Styling | MIT |
| @supabase/supabase-js, @supabase/ssr | Supabase Auth and client (Supabase mode) | MIT |
| pg (node-postgres) | Postgres access with row-level security | MIT |
| qrcode | Renders the signed session codes as QR | MIT |
| zod | Input validation | MIT |
| Vitest | Unit and database tests | MIT |
| Playwright | End-to-end test | Apache-2.0 |
| TypeScript, tsx, ESLint | Tooling | Apache-2.0 / MIT |

Course names in `supabase/seed/courses.sql` are drafted and must be checked against the public Teknik Komputer UI curriculum.
