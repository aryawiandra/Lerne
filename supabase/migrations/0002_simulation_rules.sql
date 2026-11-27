-- Lerne — rules added after the credit-economy simulation (sim/credit_sim.py):
--   1. Safety-net credit: a user at a zero balance can claim +1 once per WIB week,
--      at most 6 times per semester (scenario E).
--   2. Fall-through: a request can be offered to at most 8 tutors in turn; each
--      decline reopens it and the next qualified tutors are suggested (scenario H).
--   3. Tutor load limit: a tutor takes at most N sessions in one WIB week
--      (default 2, adjustable 1-10 by the tutor), to spread demand.
-- Runs on Supabase and on the local Postgres fallback, after 0001_init.sql.

-- ---------------------------------------------------------------------------
-- Constants
-- ---------------------------------------------------------------------------
create or replace function public.lerne_safety_net_max_per_semester() returns integer
language sql immutable as $$ select 6 $$;

create or replace function public.lerne_fallthrough_max_tutors() returns integer
language sql immutable as $$ select 8 $$;

create or replace function public.lerne_default_weekly_session_limit() returns integer
language sql immutable as $$ select 2 $$;

-- ---------------------------------------------------------------------------
-- Schema changes
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists weekly_session_limit smallint not null default 2
    check (weekly_session_limit between 1 and 10);

alter table public.credit_ledger drop constraint if exists credit_ledger_reason_check;
alter table public.credit_ledger add constraint credit_ledger_reason_check
  check (reason in ('signup_grant', 'session_taught', 'session_learned', 'demo_adjustment', 'safety_net_grant'));
alter table public.credit_ledger add constraint credit_ledger_safety_net_check
  check (reason <> 'safety_net_grant' or delta = 1);

-- ---------------------------------------------------------------------------
-- Helpers (not callable by clients)
-- ---------------------------------------------------------------------------
-- UI semesters: odd semester 1 Aug - 31 Jan, even semester 1 Feb - 31 Jul (WIB).
create or replace function public.lerne_semester_start(p_at timestamptz) returns timestamptz
language sql immutable set search_path = public, pg_temp as $$
  select (case
            when extract(month from local_at) >= 8 then make_date(extract(year from local_at)::int, 8, 1)
            when extract(month from local_at) = 1 then make_date(extract(year from local_at)::int - 1, 8, 1)
            else make_date(extract(year from local_at)::int, 2, 1)
          end)::timestamp at time zone 'Asia/Jakarta'
  from (select p_at at time zone 'Asia/Jakarta' as local_at) t
$$;

-- Sessions a tutor has (scheduled, in progress or completed) in the WIB week of p_at.
create or replace function public.tutor_sessions_in_week(p_tutor uuid, p_at timestamptz) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from public.tutoring_sessions
  where tutor_id = p_tutor
    and date_trunc('week', scheduled_start at time zone public.lerne_timezone())
        = date_trunc('week', p_at at time zone public.lerne_timezone())
$$;

create or replace function public.request_decline_count(p_request_id uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from public.request_declines where request_id = p_request_id
$$;

-- ---------------------------------------------------------------------------
-- 1. Safety-net credit
-- ---------------------------------------------------------------------------
-- Grants +1 if the caller's balance is 0, they have not had one this WIB week,
-- and they have had fewer than 6 this semester. Returns 1 if granted, else 0.
create or replace function public.claim_safety_net_credit() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_uid();
begin
  perform 1 from public.profiles where id = v_uid for update;
  if public.balance_of(v_uid) <> 0 then
    return 0;
  end if;
  if exists (
    select 1 from public.credit_ledger
    where user_id = v_uid and reason = 'safety_net_grant'
      and date_trunc('week', created_at at time zone public.lerne_timezone())
          = date_trunc('week', now() at time zone public.lerne_timezone())
  ) then
    return 0;
  end if;
  if (select count(*) from public.credit_ledger
      where user_id = v_uid and reason = 'safety_net_grant'
        and created_at >= public.lerne_semester_start(now()))
     >= public.lerne_safety_net_max_per_semester() then
    return 0;
  end if;
  insert into public.credit_ledger (user_id, delta, reason) values (v_uid, 1, 'safety_net_grant');
  return 1;
end
$$;

-- How many safety-net credits the caller has had this semester.
create or replace function public.my_safety_net_used() returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from public.credit_ledger
  where user_id = auth.uid() and reason = 'safety_net_grant'
    and created_at >= public.lerne_semester_start(now())
$$;

-- ---------------------------------------------------------------------------
-- 3. Tutor load limit (adjustable by the tutor)
-- ---------------------------------------------------------------------------
create or replace function public.set_weekly_session_limit(p_limit integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_uid();
begin
  if p_limit not between 1 and 10 then
    raise exception 'INVALID_INPUT: weekly session limit must be 1-10';
  end if;
  update public.profiles set weekly_session_limit = p_limit where id = v_uid;
end
$$;

-- ---------------------------------------------------------------------------
-- Matching data now includes the tutor's load in the request's week.
-- ---------------------------------------------------------------------------
drop function if exists public.match_candidates(uuid);
create function public.match_candidates(p_request_id uuid)
returns table (
  tutor_id uuid, display_name text, slots jsonb,
  rating_avg numeric, rating_count integer, pair_credits_this_week integer, declined boolean,
  sessions_in_week integer, weekly_session_limit integer
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
    exists (select 1 from public.request_declines d where d.request_id = r.id and d.tutor_id = p.id),
    public.tutor_sessions_in_week(p.id, r.preferred_start),
    p.weekly_session_limit::integer
  from public.profiles p
  join public.tutor_courses tc on tc.user_id = p.id and tc.course_code = r.course_code
  where p.id <> r.learner_id
    and public.request_decline_count(r.id) < public.lerne_fallthrough_max_tutors();
end
$$;

-- ---------------------------------------------------------------------------
-- assign_tutor / respond_to_request: same as 0001 plus fall-through limit and load limit.
-- ---------------------------------------------------------------------------
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
  if public.request_decline_count(r.id) >= public.lerne_fallthrough_max_tutors() then
    raise exception 'FALLTHROUGH_LIMIT: % tutors already declined this request', public.lerne_fallthrough_max_tutors();
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
  if public.tutor_sessions_in_week(p_tutor_id, r.preferred_start)
     >= (select weekly_session_limit from public.profiles where id = p_tutor_id) then
    raise exception 'TUTOR_WEEKLY_LOAD: this tutor is fully booked that week';
  end if;

  update public.help_requests set status = 'pending', tutor_id = p_tutor_id, updated_at = now()
  where id = r.id;
end
$$;

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

  perform 1 from public.profiles where id = v_uid for update; -- serialise this tutor's accepts
  perform 1 from public.profiles where id = r.learner_id for update;
  if public.balance_of(r.learner_id) < public.reserved_of(r.learner_id) then
    raise exception 'INSUFFICIENT_CREDITS: learner no longer has enough credits';
  end if;
  if public.pair_committed_this_week(v_uid, r.learner_id) + r.duration_hours > public.lerne_pair_weekly_cap() then
    raise exception 'PAIR_WEEKLY_CAP: weekly limit with this learner reached';
  end if;
  if public.tutor_sessions_in_week(v_uid, r.preferred_start)
     >= (select weekly_session_limit from public.profiles where id = v_uid) then
    raise exception 'TUTOR_WEEKLY_LOAD: you already have your maximum sessions that week';
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
-- Privileges: new functions start closed; grant only the client API.
-- ---------------------------------------------------------------------------
revoke all on function
  public.lerne_safety_net_max_per_semester(), public.lerne_fallthrough_max_tutors(),
  public.lerne_default_weekly_session_limit(), public.lerne_semester_start(timestamptz),
  public.tutor_sessions_in_week(uuid, timestamptz), public.request_decline_count(uuid),
  public.claim_safety_net_credit(), public.my_safety_net_used(), public.set_weekly_session_limit(integer),
  public.match_candidates(uuid)
from public, anon, authenticated;

grant execute on function
  public.lerne_safety_net_max_per_semester(), public.lerne_fallthrough_max_tutors(),
  public.lerne_default_weekly_session_limit(),
  public.claim_safety_net_credit(), public.my_safety_net_used(), public.set_weekly_session_limit(integer),
  public.match_candidates(uuid)
to authenticated;
-- A tutor's weekly limit is not sensitive; matching reads it through match_candidates.
grant select (weekly_session_limit) on public.profiles to authenticated;
-- Deliberately NOT granted: lerne_semester_start, tutor_sessions_in_week, request_decline_count.
