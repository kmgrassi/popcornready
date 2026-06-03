-- public.users: the app/domain user table, decoupled from auth.users.
--
-- Identity model (per harper-server):
--   * auth.uid()         = the Supabase auth user id (auth.users.id)
--   * public.users.id    = the app/domain user id (its own uuid)
--   * public.users.auth_id links the two, and is NULL until the person signs up.
--
-- Decoupling (rather than public.users.id = auth.uid()) is deliberate: it lets us
-- create a domain user BEFORE they authenticate — e.g. inviting someone to a
-- workspace who has no auth account yet. A SECURITY DEFINER trigger on auth.users
-- then *links* that pre-created row on signup (matched by email) instead of
-- creating a duplicate. RLS resolves auth.uid() -> public.users.id via the
-- current_app_user_id() helper.
--
-- !! Identity & RLS conventions (which id to compare in a policy) are documented
-- in docs/supabase-identity-and-rls.md and supabase/README.md. Read them before
-- adding any policy that references a user.

create table public.users (
  id          uuid primary key default gen_random_uuid(),
  -- Nullable link to the Supabase auth user. NULL = invited / not yet signed up.
  -- on delete set null: deleting the auth account unlinks but keeps the domain
  -- user (and their workspace data) intact.
  auth_id     uuid unique references auth.users (id) on delete set null,
  email       text,
  full_name   text,
  first_name  text,
  last_name   text,
  avatar_url  text,
  metadata    jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One unlinked (pre-auth) row per email, so the signup trigger can link
-- unambiguously. Linked rows (auth_id set) are exempt — auth.users already
-- guarantees email uniqueness for them.
create unique index users_unique_unlinked_email
  on public.users (lower(btrim(email)))
  where auth_id is null and email is not null and btrim(email) <> '';

-- --- updated_at maintenance ------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

-- --- auth.uid() -> public.users.id mapping ---------------------------------
-- SECURITY DEFINER so it can read public.users from inside other tables' RLS
-- policies without recursing through public.users' own RLS. App-table policies
-- should reference public.current_app_user_id() rather than auth.uid() directly.
create or replace function public.current_app_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.users where auth_id = auth.uid() limit 1
$$;

revoke all on function public.current_app_user_id() from public;
grant execute on function public.current_app_user_id() to authenticated, service_role;

-- --- auth.users -> public.users mirror / link ------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_first_name text := new.raw_user_meta_data ->> 'first_name';
  v_last_name  text := new.raw_user_meta_data ->> 'last_name';
  v_full_name  text := nullif(btrim(concat_ws(' ', v_first_name, v_last_name)), '');
  v_email      text := coalesce(new.email, new.raw_user_meta_data ->> 'email');
  v_existing   uuid;
begin
  -- Adopt a pre-created (invited) row when exactly one unlinked match exists.
  if nullif(v_email, '') is not null then
    select id into v_existing
    from public.users
    where auth_id is null
      and lower(btrim(email)) = lower(btrim(v_email));
  end if;

  if v_existing is not null then
    update public.users set
      auth_id    = new.id,
      first_name = coalesce(first_name, nullif(v_first_name, '')),
      last_name  = coalesce(last_name,  nullif(v_last_name, '')),
      full_name  = coalesce(full_name,  v_full_name),
      avatar_url = coalesce(avatar_url, new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'),
      metadata   = metadata || coalesce(new.raw_user_meta_data, '{}'::jsonb)
    where id = v_existing;
  else
    insert into public.users (auth_id, email, full_name, first_name, last_name, avatar_url, metadata)
    values (
      new.id,
      v_email,
      coalesce(v_full_name, new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
      v_first_name,
      v_last_name,
      coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'),
      coalesce(new.raw_user_meta_data, '{}'::jsonb)
    );
  end if;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill: create a domain row for any auth user that has no linked row yet.
-- The profile extraction here MUST stay in sync with handle_new_user's insert
-- branch above, otherwise migrated accounts get sparser profiles than new
-- signups (name/avatar/metadata come from raw_user_meta_data either way).
insert into public.users (auth_id, email, full_name, first_name, last_name, avatar_url, metadata)
select
  au.id,
  coalesce(au.email, au.raw_user_meta_data ->> 'email'),
  coalesce(
    nullif(btrim(concat_ws(' ', au.raw_user_meta_data ->> 'first_name', au.raw_user_meta_data ->> 'last_name')), ''),
    au.raw_user_meta_data ->> 'full_name',
    au.raw_user_meta_data ->> 'name'
  ),
  au.raw_user_meta_data ->> 'first_name',
  au.raw_user_meta_data ->> 'last_name',
  coalesce(au.raw_user_meta_data ->> 'avatar_url', au.raw_user_meta_data ->> 'picture'),
  coalesce(au.raw_user_meta_data, '{}'::jsonb)
from auth.users au
where not exists (select 1 from public.users u where u.auth_id = au.id)
on conflict do nothing;

-- --- RLS -------------------------------------------------------------------
-- A signed-in user can read/update only their own linked row. Pre-auth (invite)
-- rows have auth_id NULL, so they are invisible to end users and are managed
-- server-side via the service_role (which bypasses RLS). Deletes happen via the
-- auth.users unlink + app logic, so no end-user insert/delete policy.
alter table public.users enable row level security;

create policy users_select_own on public.users
  for select to authenticated
  using (auth_id = auth.uid());

create policy users_update_own on public.users
  for update to authenticated
  using (auth_id = auth.uid())
  with check (auth_id = auth.uid());
