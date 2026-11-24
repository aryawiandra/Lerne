-- LOCAL FALLBACK ONLY. Do NOT run this against a real Supabase project.
--
-- Emulates the small part of Supabase that Lerne's migrations depend on, so the
-- exact same migration (supabase/migrations/*.sql) can run on a plain local
-- Postgres when Docker / the Supabase CLI are unavailable:
--   * roles: anon, authenticated, service_role
--   * schema auth with auth.users and auth.uid() (reads request.jwt.claims, as
--     Supabase does)
--   * schema extensions (Supabase installs pgcrypto there)
-- Supabase Auth itself (email OTP, sessions) is NOT emulated; local mode uses a
-- clearly-labelled dev sign-in bypass instead (see README).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
