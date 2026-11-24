-- Lerne: peer-tutoring time bank — initial schema.
-- Target: Supabase Postgres (auth.users, auth.uid(), roles anon/authenticated).
-- Locally the same file runs on plain Postgres after db/local/00_supabase_shim.sql.
--
-- Design rules enforced HERE (not only in the UI):
--   * every public table has Row Level Security enabled
--   * credit_ledger is append-only (UPDATE/DELETE/TRUNCATE rejected by trigger)
--   * a user's balance can never go below 0 (checked on every ledger insert,
--     with the user's profile row locked to serialise concurrent settlements)
--   * a tutor can earn at most lerne_pair_weekly_cap() credits per week from the
--     same learner (anti-farming)
--   * new users start with lerne_starting_credits() credits
--   * session start/end requires a short-lived HMAC-signed token issued to the
--     tutor and redeemed by the learner (the QR code)

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Constants
-- ---------------------------------------------------------------------------
create or replace function public.lerne_starting_credits() returns integer
language sql immutable as $$ select 2 $$;

create or replace function public.lerne_pair_weekly_cap() returns integer
language sql immutable as $$ select 3 $$;

create or replace function public.lerne_token_ttl_seconds() returns integer
language sql immutable as $$ select 120 $$;

create or replace function public.lerne_timezone() returns text
language sql immutable as $$ select 'Asia/Jakarta'::text $$;

-- ---------------------------------------------------------------------------
-- Private schema: signing key for session QR tokens (never exposed to clients)
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;

create table if not exists private.app_secrets (
  name text primary key,
  value text not null
);
alter table private.app_secrets enable row level security;
revoke all on table private.app_secrets from public;

insert into private.app_secrets (name, value)
values ('session_token_key', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.courses (
  code text primary key check (code ~ '^[A-Z0-9-]{3,20}$'),
  name text not null check (char_length(name) between 3 and 120),
  semester smallint not null check (semester between 1 and 8),
  program text not null default 'Teknik Komputer',
  faculty text not null default 'Fakultas Teknik'
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique check (email ~ '^[a-z0-9._%+-]+@ui\.ac\.id$'),
  display_name text not null check (char_length(display_name) between 1 and 80),
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.tutor_courses (
  user_id uuid not null references public.profiles (id) on delete cascade,
  course_code text not null references public.courses (code),
  created_at timestamptz not null default now(),
  primary key (user_id, course_code)
);

-- Weekly free slots. day_of_week: ISO 1=Monday .. 7=Sunday. Minutes since
-- midnight in Asia/Jakarta (WIB). Slots do not cross midnight.
create table public.availability_slots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 1 and 7),
  start_minute integer not null check (start_minute between 0 and 1439),
  end_minute integer not null check (end_minute between 1 and 1440),
  created_at timestamptz not null default now(),
  check (end_minute > start_minute),
  unique (user_id, day_of_week, start_minute, end_minute)
);

create table public.help_requests (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references public.profiles (id) on delete cascade,
  course_code text not null references public.courses (code),
  topic text not null check (char_length(topic) between 3 and 200),
  preferred_start timestamptz not null,
  duration_hours smallint not null check (duration_hours between 1 and 3),
  -- open: looking for a tutor; pending: waiting for tutor_id to respond;
  -- accepted: session exists; completed; cancelled
  status text not null default 'open'
    check (status in ('open', 'pending', 'accepted', 'completed', 'cancelled')),
  tutor_id uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (tutor_id is null or tutor_id <> learner_id),
  check ((status = 'open' and tutor_id is null) or status = 'cancelled' or tutor_id is not null)
);
create index help_requests_learner_idx on public.help_requests (learner_id);
create index help_requests_tutor_idx on public.help_requests (tutor_id);

create table public.request_declines (
  request_id uuid not null references public.help_requests (id) on delete cascade,
  tutor_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (request_id, tutor_id)
);

create table public.tutoring_sessions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.help_requests (id),
  tutor_id uuid not null references public.profiles (id),
  learner_id uuid not null references public.profiles (id),
  course_code text not null references public.courses (code),
  scheduled_start timestamptz not null,
  duration_hours smallint not null check (duration_hours between 1 and 3),
  status text not null default 'scheduled'
    check (status in ('scheduled', 'in_progress', 'completed')),
  started_at timestamptz,
  ended_at timestamptz,
  credits_transferred smallint,
  created_at timestamptz not null default now(),
  check (tutor_id <> learner_id)
);
create index tutoring_sessions_tutor_idx on public.tutoring_sessions (tutor_id);
create index tutoring_sessions_learner_idx on public.tutoring_sessions (learner_id);

create table public.credit_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id),
  delta integer not null check (delta <> 0),
  reason text not null
    check (reason in ('signup_grant', 'session_taught', 'session_learned', 'demo_adjustment')),
  session_id uuid references public.tutoring_sessions (id),
  counterparty_id uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  check (reason not in ('session_taught', 'session_learned')
         or (session_id is not null and counterparty_id is not null)),
  check (reason <> 'session_taught' or delta > 0),
  check (reason <> 'session_learned' or delta < 0)
);
create index credit_ledger_user_idx on public.credit_ledger (user_id, created_at);
create unique index credit_ledger_one_entry_per_session_side
  on public.credit_ledger (session_id, reason) where session_id is not null;

create table public.ratings (
  session_id uuid not null references public.tutoring_sessions (id),
  rater_id uuid not null references public.profiles (id),
  ratee_id uuid not null references public.profiles (id),
  score smallint not null check (score between 1 and 5),
  created_at timestamptz not null default now(),
  primary key (session_id, rater_id),
  check (rater_id <> ratee_id)
);
create index ratings_ratee_idx on public.ratings (ratee_id);

-- ---------------------------------------------------------------------------
-- Ledger integrity
-- ---------------------------------------------------------------------------
create or replace function public.ledger_reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'LEDGER_APPEND_ONLY: credit_ledger rows cannot be updated or deleted';
end
$$;

create trigger credit_ledger_no_update_delete
  before update or delete on public.credit_ledger
  for each row execute function public.ledger_reject_mutation();

create trigger credit_ledger_no_truncate
  before truncate on public.credit_ledger
  for each statement execute function public.ledger_reject_mutation();

create or replace function public.ledger_check_invariants() returns trigger
language plpgsql as $$
declare
  v_balance integer;
  v_pair_week integer;
begin
  -- Serialise all ledger writes for this user.
  perform 1 from public.profiles where id = new.user_id for update;

  select coalesce(sum(delta), 0) into v_balance
  from public.credit_ledger where user_id = new.user_id;

  if v_balance < 0 then
    raise exception 'INSUFFICIENT_CREDITS: balance would become % for user %', v_balance, new.user_id;
  end if;

  if new.reason = 'session_taught' then
    select coalesce(sum(delta), 0) into v_pair_week
    from public.credit_ledger
    where user_id = new.user_id
      and counterparty_id = new.counterparty_id
      and reason = 'session_taught'
      and date_trunc('week', created_at at time zone public.lerne_timezone())
          = date_trunc('week', now() at time zone public.lerne_timezone());

    if v_pair_week > public.lerne_pair_weekly_cap() then
      raise exception 'PAIR_WEEKLY_CAP: tutor would earn % credits from this learner this week (cap %)',
        v_pair_week, public.lerne_pair_weekly_cap();
    end if;
  end if;

  return null;
end
$$;

create constraint trigger credit_ledger_invariants
  after insert on public.credit_ledger
  for each row execute function public.ledger_check_invariants();

-- ---------------------------------------------------------------------------
-- New user → profile + starting credits (and campus email restriction)
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_email text := lower(coalesce(new.email, ''));
  v_name text;
begin
  if v_email !~ '^[a-z0-9._%+-]+@ui\.ac\.id$' then
    raise exception 'EMAIL_DOMAIN: only @ui.ac.id addresses may sign up (got %)', v_email;
  end if;

  v_name := coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(v_email, '@', 1));

  insert into public.profiles (id, email, display_name, is_synthetic)
  values (new.id, v_email, left(v_name, 80), coalesce((new.raw_user_meta_data ->> 'is_synthetic')::boolean, false));

  insert into public.credit_ledger (user_id, delta, reason)
  values (new.id, public.lerne_starting_credits(), 'signup_grant');

  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.require_uid() returns uuid
language plpgsql stable as $$
declare v uuid := auth.uid();
begin
  if v is null then
    raise exception 'NOT_AUTHENTICATED: sign in first';
  end if;
  return v;
end
$$;

create or replace function public.balance_of(p_user uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(delta), 0)::integer from public.credit_ledger where user_id = p_user
$$;

-- Credits reserved by a learner's open / pending / accepted requests.
create or replace function public.reserved_of(p_user uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(duration_hours), 0)::integer
  from public.help_requests
  where learner_id = p_user and status in ('open', 'pending', 'accepted')
$$;

-- Credits this tutor already earned from this learner this week, plus hours of
-- their accepted-but-unfinished sessions.
create or replace function public.pair_committed_this_week(p_tutor uuid, p_learner uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select (
    select coalesce(sum(delta), 0) from public.credit_ledger
    where user_id = p_tutor and counterparty_id = p_learner and reason = 'session_taught'
      and date_trunc('week', created_at at time zone public.lerne_timezone())
          = date_trunc('week', now() at time zone public.lerne_timezone())
  )::integer + (
    select coalesce(sum(duration_hours), 0) from public.tutoring_sessions
    where tutor_id = p_tutor and learner_id = p_learner and status in ('scheduled', 'in_progress')
  )::integer
$$;

create or replace function public.my_credit_summary()
returns table (balance integer, reserved integer, available integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select public.balance_of(auth.uid()),
         public.reserved_of(auth.uid()),
         public.balance_of(auth.uid()) - public.reserved_of(auth.uid())
$$;

-- ---------------------------------------------------------------------------
-- Request lifecycle
-- ---------------------------------------------------------------------------
create or replace function public.create_help_request(
  p_course_code text, p_topic text, p_preferred_start timestamptz, p_duration_hours integer
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_uid();
  v_id uuid;
begin
  if p_duration_hours not between 1 and 3 then
    raise exception 'INVALID_INPUT: duration must be 1-3 hours';
  end if;
  if p_preferred_start < now() - interval '1 hour' then
    raise exception 'INVALID_INPUT: preferred time is in the past';
  end if;

  perform 1 from public.profiles where id = v_uid for update;
  if public.balance_of(v_uid) - public.reserved_of(v_uid) < p_duration_hours then
    raise exception 'INSUFFICIENT_CREDITS: available % credit(s), request needs %',
      public.balance_of(v_uid) - public.reserved_of(v_uid), p_duration_hours;
  end if;

  insert into public.help_requests (learner_id, course_code, topic, preferred_start, duration_hours)
  values (v_uid, p_course_code, trim(p_topic), p_preferred_start, p_duration_hours)
  returning id into v_id;
  return v_id;
end
$$;

-- Candidate tutors for a request (data only; ranking happens in app code,
-- src/lib/matching.ts, so the rules are unit-testable).
create or replace function public.match_candidates(p_request_id uuid)
returns table (
  tutor_id uuid, display_name text, slots jsonb,
  rating_avg numeric, rating_count integer, pair_credits_this_week integer, declined boolean
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_uid();
  r public.help_requests;
begin
  select * into r from public.help_requests where id = p_request_id;
  if not found or r.learner_id <> v_uid then
    raise exception 'NOT_FOUND: request not found';
  end if;

  return query
  select p.id, p.display_name,
    coalesce((select jsonb_agg(jsonb_build_object(
                'dayOfWeek', s.day_of_week, 'startMinute', s.start_minute, 'endMinute', s.end_minute))
              from public.availability_slots s where s.user_id = p.id), '[]'::jsonb),
    (select round(avg(score)::numeric, 2) from public.ratings rt where rt.ratee_id = p.id),
    (select count(*)::integer from public.ratings rt where rt.ratee_id = p.id),
    public.pair_committed_this_week(p.id, r.learner_id),
    exists (select 1 from public.request_declines d where d.request_id = r.id and d.tutor_id = p.id)
  from public.profiles p
  join public.tutor_courses tc on tc.user_id = p.id and tc.course_code = r.course_code
  where p.id <> r.learner_id;
end
$$;

create or replace function public.assign_tutor(p_request_id uuid, p_tutor_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_uid();
  r public.help_requests;
begin
  select * into r from public.help_requests where id = p_request_id for update;
  if not found or r.learner_id <> v_uid then
    raise exception 'NOT_FOUND: request not found';
  end if;
  if r.status <> 'open' then
    raise exception 'INVALID_STATE: request is %', r.status;
  end if;
  if p_tutor_id = v_uid then
    raise exception 'INVALID_INPUT: you cannot tutor yourself';
  end if;
  if not exists (select 1 from public.tutor_courses where user_id = p_tutor_id and course_code = r.course_code) then
    raise exception 'INVALID_INPUT: tutor does not teach this course';
  end if;
  if exists (select 1 from public.request_declines where request_id = r.id and tutor_id = p_tutor_id) then
    raise exception 'INVALID_INPUT: tutor already declined this request';
  end if;
  if public.pair_committed_this_week(p_tutor_id, v_uid) + r.duration_hours > public.lerne_pair_weekly_cap() then
    raise exception 'PAIR_WEEKLY_CAP: this tutor has reached the weekly limit with you';
  end if;

  update public.help_requests set status = 'pending', tutor_id = p_tutor_id, updated_at = now()
  where id = r.id;
end
$$;

create or replace function public.cancel_help_request(p_request_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_uid();
  r public.help_requests;
begin
  select * into r from public.help_requests where id = p_request_id for update;
  if not found or r.learner_id <> v_uid then
    raise exception 'NOT_FOUND: request not found';
  end if;
  if r.status not in ('open', 'pending') then
    raise exception 'INVALID_STATE: request is %', r.status;
  end if;
  update public.help_requests set status = 'cancelled', updated_at = now() where id = r.id;
end
$$;

-- Tutor accepts (→ session created) or declines (→ request reopens).
create or replace function public.respond_to_request(p_request_id uuid, p_accept boolean) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_uid();
  r public.help_requests;
  v_session uuid;
begin
  select * into r from public.help_requests where id = p_request_id for update;
  if not found or r.tutor_id is distinct from v_uid then
    raise exception 'NOT_FOUND: request not found';
  end if;
  if r.status <> 'pending' then
    raise exception 'INVALID_STATE: request is %', r.status;
  end if;

  if not p_accept then
    insert into public.request_declines (request_id, tutor_id) values (r.id, v_uid)
    on conflict do nothing;
    update public.help_requests set status = 'open', tutor_id = null, updated_at = now() where id = r.id;
    return null;
  end if;

  perform 1 from public.profiles where id = r.learner_id for update;
  if public.balance_of(r.learner_id) < public.reserved_of(r.learner_id) then
    raise exception 'INSUFFICIENT_CREDITS: learner no longer has enough credits';
  end if;
  if public.pair_committed_this_week(v_uid, r.learner_id) + r.duration_hours > public.lerne_pair_weekly_cap() then
    raise exception 'PAIR_WEEKLY_CAP: weekly limit with this learner reached';
  end if;

  insert into public.tutoring_sessions
    (request_id, tutor_id, learner_id, course_code, scheduled_start, duration_hours)
  values (r.id, v_uid, r.learner_id, r.course_code, r.preferred_start, r.duration_hours)
  returning id into v_session;

  update public.help_requests set status = 'accepted', updated_at = now() where id = r.id;
  return v_session;
end
$$;

-- ---------------------------------------------------------------------------
-- Session QR tokens: <session_id>.<start|end>.<exp_epoch>.<hmac128hex>
-- ---------------------------------------------------------------------------
create or replace function public._sign_session_token(p_session_id uuid, p_phase text, p_exp bigint)
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select p_session_id::text || '.' || p_phase || '.' || p_exp::text || '.' ||
    left(encode(extensions.hmac(
      p_session_id::text || '.' || p_phase || '.' || p_exp::text,
      (select value from private.app_secrets where name = 'session_token_key'),
      'sha256'), 'hex'), 32)
$$;

create or replace function public.issue_session_token(p_session_id uuid, p_phase text)
returns table (token text, expires_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_uid();
  s public.tutoring_sessions;
  v_exp bigint;
begin
  select * into s from public.tutoring_sessions where id = p_session_id;
  if not found or s.tutor_id <> v_uid then
    raise exception 'NOT_FOUND: session not found';
  end if;
  if p_phase = 'start' and s.status <> 'scheduled' then
    raise exception 'INVALID_STATE: session is %', s.status;
  elsif p_phase = 'end' and s.status <> 'in_progress' then
    raise exception 'INVALID_STATE: session is %', s.status;
  elsif p_phase not in ('start', 'end') then
    raise exception 'INVALID_INPUT: phase must be start or end';
  end if;

  v_exp := floor(extract(epoch from now()))::bigint + public.lerne_token_ttl_seconds();
  return query select public._sign_session_token(s.id, p_phase, v_exp), to_timestamp(v_exp);
end
$$;

create or replace function public.redeem_session_token(p_token text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_uid();
  v_parts text[] := string_to_array(trim(coalesce(p_token, '')), '.');
  v_session_id uuid;
  v_phase text;
  v_exp bigint;
  s public.tutoring_sessions;
begin
  if coalesce(array_length(v_parts, 1), 0) <> 4
     or v_parts[1] !~ '^[0-9a-f-]{36}$' or v_parts[3] !~ '^[0-9]{1,12}$' then
    raise exception 'INVALID_TOKEN: malformed code';
  end if;
  v_session_id := v_parts[1]::uuid;
  v_phase := v_parts[2];
  v_exp := v_parts[3]::bigint;

  if public._sign_session_token(v_session_id, v_phase, v_exp) <> trim(p_token) then
    raise exception 'INVALID_TOKEN: signature mismatch';
  end if;
  if v_exp < floor(extract(epoch from now())) then
    raise exception 'TOKEN_EXPIRED: ask the tutor to show a fresh QR code';
  end if;

  select * into s from public.tutoring_sessions where id = v_session_id for update;
  if not found or s.learner_id <> v_uid then
    raise exception 'NOT_FOUND: this code is not for one of your sessions';
  end if;

  if v_phase = 'start' then
    if s.status <> 'scheduled' then
      raise exception 'INVALID_STATE: session is %', s.status;
    end if;
    update public.tutoring_sessions set status = 'in_progress', started_at = now() where id = s.id;
    return 'in_progress';
  elsif v_phase = 'end' then
    if s.status <> 'in_progress' then
      raise exception 'INVALID_STATE: session is %', s.status;
    end if;
    -- Settlement. Learner debit first; ledger triggers enforce balance >= 0
    -- and the pair weekly cap. Any failure rolls back the whole transition.
    insert into public.credit_ledger (user_id, delta, reason, session_id, counterparty_id)
    values (s.learner_id, -s.duration_hours, 'session_learned', s.id, s.tutor_id);
    insert into public.credit_ledger (user_id, delta, reason, session_id, counterparty_id)
    values (s.tutor_id, s.duration_hours, 'session_taught', s.id, s.learner_id);

    update public.tutoring_sessions
      set status = 'completed', ended_at = now(), credits_transferred = s.duration_hours
      where id = s.id;
    update public.help_requests set status = 'completed', updated_at = now() where id = s.request_id;
    return 'completed';
  end if;

  raise exception 'INVALID_TOKEN: unknown phase';
end
$$;

create or replace function public.rate_session(p_session_id uuid, p_score integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_uid();
  s public.tutoring_sessions;
begin
  select * into s from public.tutoring_sessions where id = p_session_id;
  if not found or v_uid not in (s.tutor_id, s.learner_id) then
    raise exception 'NOT_FOUND: session not found';
  end if;
  if s.status <> 'completed' then
    raise exception 'INVALID_STATE: you can rate only after the session ends';
  end if;
  if p_score not between 1 and 5 then
    raise exception 'INVALID_INPUT: score must be 1-5';
  end if;

  insert into public.ratings (session_id, rater_id, ratee_id, score)
  values (s.id, v_uid, case when v_uid = s.tutor_id then s.learner_id else s.tutor_id end, p_score);
exception when unique_violation then
  raise exception 'ALREADY_RATED: you already rated this session';
end
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.courses enable row level security;
alter table public.profiles enable row level security;
alter table public.tutor_courses enable row level security;
alter table public.availability_slots enable row level security;
alter table public.help_requests enable row level security;
alter table public.request_declines enable row level security;
alter table public.tutoring_sessions enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.ratings enable row level security;

-- Start from zero privileges (Supabase grants ALL to anon/authenticated by default).
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant select on public.courses to authenticated;
create policy courses_read on public.courses for select to authenticated using (true);

-- Directory: everyone signed in sees names; email column is NOT granted.
grant select (id, display_name, is_synthetic, created_at) on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
create policy profiles_read on public.profiles for select to authenticated using (true);
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

grant select, insert, delete on public.tutor_courses to authenticated;
create policy tutor_courses_read on public.tutor_courses for select to authenticated using (true);
create policy tutor_courses_insert_own on public.tutor_courses for insert to authenticated
  with check (user_id = auth.uid());
create policy tutor_courses_delete_own on public.tutor_courses for delete to authenticated
  using (user_id = auth.uid());

grant select, insert, delete on public.availability_slots to authenticated;
create policy slots_read on public.availability_slots for select to authenticated using (true);
create policy slots_insert_own on public.availability_slots for insert to authenticated
  with check (user_id = auth.uid());
create policy slots_delete_own on public.availability_slots for delete to authenticated
  using (user_id = auth.uid());

-- Writes go through security-definer functions only.
grant select on public.help_requests to authenticated;
create policy requests_read_participants on public.help_requests for select to authenticated
  using (learner_id = auth.uid() or tutor_id = auth.uid());

grant select on public.request_declines to authenticated;
create policy declines_read on public.request_declines for select to authenticated
  using (tutor_id = auth.uid()
         or exists (select 1 from public.help_requests r where r.id = request_id and r.learner_id = auth.uid()));

grant select on public.tutoring_sessions to authenticated;
create policy sessions_read_participants on public.tutoring_sessions for select to authenticated
  using (tutor_id = auth.uid() or learner_id = auth.uid());

grant select on public.credit_ledger to authenticated;
create policy ledger_read_own on public.credit_ledger for select to authenticated
  using (user_id = auth.uid());

grant select on public.ratings to authenticated;
create policy ratings_read_own on public.ratings for select to authenticated
  using (rater_id = auth.uid() or ratee_id = auth.uid());

-- Callable API for signed-in users.
grant execute on function
  public.lerne_starting_credits(), public.lerne_pair_weekly_cap(), public.lerne_token_ttl_seconds(),
  public.lerne_timezone(), public.require_uid(), public.my_credit_summary(),
  public.create_help_request(text, text, timestamptz, integer),
  public.match_candidates(uuid), public.assign_tutor(uuid, uuid), public.cancel_help_request(uuid),
  public.respond_to_request(uuid, boolean),
  public.issue_session_token(uuid, text), public.redeem_session_token(text),
  public.rate_session(uuid, integer)
to authenticated;
-- Deliberately NOT granted: balance_of, reserved_of, pair_committed_this_week,
-- _sign_session_token, handle_new_user, ledger_* trigger functions.
