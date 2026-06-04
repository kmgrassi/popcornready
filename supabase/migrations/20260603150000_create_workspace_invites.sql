-- Workspace invites: pending invitations to join a workspace, including people
-- who don't have an account yet.
--
-- Builds on public.users (domain user table), public.workspaces, and
-- public.workspace_members. This is the *pending* side of the invite lifecycle;
-- once an invite is accepted it materializes a public.workspace_members row and
-- the invite is marked 'accepted' (terminal). The invites table is intentionally
-- NOT the source of truth for active membership -- workspace_members is.
--
-- Identity model (see docs/supabase-identity-and-rls.md):
--   * auth.uid()              = the Supabase auth session id (never leaves RLS)
--   * public.users.id         = the app/domain user id  <- invited_by/accepted_by key on this
--   * current_app_user_id()   = the caller's public.users.id
--
-- Two ways an invite becomes a membership:
--   1. accept_workspace_invite(token) -- explicit, link/token flow (this file).
--   2. handle_new_user adoption + a workspace_members row -- the existing
--      "auth_id NULL pre-created row" path (workspace_members migration / Track F).
-- We keep accept *explicit* via the token RPC (see PR notes) rather than
-- auto-accepting all pending invites by email inside handle_new_user: a single
-- email may have invites to many workspaces with different roles, and silently
-- joining every one on signup is surprising and hard to audit. The token RPC
-- makes "which workspace, which role" an explicit, idempotent action and lets the
-- invitee click a specific invite link. handle_new_user is left untouched.

-- gen_random_bytes() (token default) lives in pgcrypto. Available on Supabase;
-- ensure it's present so this migration is self-contained.
create extension if not exists pgcrypto;

-- --- invites table ----------------------------------------------------------
create table public.workspace_invites (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  text not null references public.workspaces (id) on delete cascade,
  -- The invitee's email. Stored as-entered; matching is case-insensitive (see
  -- the lower() index and the accept function). No FK to public.users on purpose:
  -- the invitee may not have a domain row yet.
  email         text not null check (btrim(email) <> ''),
  role          text not null default 'member' check (role in ('owner', 'admin', 'member')),
  -- Who sent the invite (domain id). on delete set null so removing the inviter
  -- doesn't drop the pending invite.
  invited_by    uuid references public.users (id) on delete set null,
  -- Opaque secret for the email accept-link flow. Generated server-side; unique
  -- so a single token resolves to exactly one invite.
  token         text not null unique default encode(gen_random_bytes(32), 'hex'),
  status        text not null default 'pending'
                  check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at    timestamptz not null default (now() + interval '14 days'),
  -- Set when accepted (domain id of the user who accepted).
  accepted_by   uuid references public.users (id) on delete set null,
  accepted_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Lookups by workspace (list a workspace's invites) and by token (accept flow).
-- token already has a unique index from the column constraint.
create index idx_workspace_invites_workspace_id on public.workspace_invites (workspace_id);
create index idx_workspace_invites_email_lower on public.workspace_invites (lower(btrim(email)));

-- At most one *pending* invite per (workspace, email) so re-inviting is an
-- upsert/refresh rather than a pile of duplicates. Accepted/revoked/expired rows
-- are historical and exempt.
create unique index workspace_invites_unique_pending
  on public.workspace_invites (workspace_id, lower(btrim(email)))
  where status = 'pending';

-- public.set_updated_at() already exists (public.users migration).
create trigger workspace_invites_set_updated_at
  before update on public.workspace_invites
  for each row execute function public.set_updated_at();

-- --- accept flow ------------------------------------------------------------
-- Resolve the caller (current_app_user_id), validate a pending, non-expired
-- invite by token, insert the workspace_members row at the invite's role, and
-- mark the invite accepted. SECURITY DEFINER so it can write workspace_members
-- and read invites regardless of the caller's RLS (the caller is an ordinary
-- authenticated user who is NOT yet a member, so they can't insert membership
-- themselves). Returns the workspace_id joined.
--
-- Idempotent-ish: if the invite is already accepted by this same caller we treat
-- it as success (returns the workspace_id) so a double-click on the accept link
-- doesn't error.
create or replace function public.accept_workspace_invite(p_token text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id      uuid := public.current_app_user_id();
  v_invite       public.workspace_invites%rowtype;
  v_caller_email text;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- Lock the invite row to serialize concurrent accepts of the same token.
  select * into v_invite
  from public.workspace_invites
  where token = p_token
  for update;

  if not found then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;

  -- Already accepted by this same caller -> idempotent success.
  if v_invite.status = 'accepted' and v_invite.accepted_by = v_user_id then
    return v_invite.workspace_id;
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'invite is % (not pending)', v_invite.status using errcode = '22023';
  end if;

  if v_invite.expires_at <= now() then
    -- Don't flip status -> 'expired' here: raising rolls back any write in this
    -- same call, so the update wouldn't stick. Expiry is *derived* from
    -- expires_at; the 'expired' status is a convenience set by a separate sweep
    -- (e.g. expire_stale_workspace_invites() below, run on a schedule or before
    -- an admin lists invites). A past-expiry pending invite is never acceptable
    -- regardless of its stored status, which this check enforces.
    raise exception 'invite has expired' using errcode = '22023';
  end if;

  -- The invite is addressed to a specific email. Only the account whose email
  -- matches may consume it -- otherwise any authenticated user holding the token
  -- could join the workspace at the invited role. Compare case-insensitively,
  -- consistent with the rest of the email handling.
  select email into v_caller_email from public.users where id = v_user_id;
  if v_caller_email is null
     or lower(btrim(v_caller_email)) is distinct from lower(btrim(v_invite.email)) then
    raise exception 'invite is addressed to a different email'
      using errcode = '42501';
  end if;

  -- Materialize membership. If the caller is somehow already a member (e.g. a
  -- prior accept via the auth_id-NULL path), keep their existing row/role rather
  -- than downgrading -- the accept still "succeeds" and the invite is consumed.
  insert into public.workspace_members (workspace_id, user_id, role, invited_by)
  values (v_invite.workspace_id, v_user_id, v_invite.role, v_invite.invited_by)
  on conflict (workspace_id, user_id) do nothing;

  update public.workspace_invites
    set status      = 'accepted',
        accepted_by = v_user_id,
        accepted_at = now()
    where id = v_invite.id;

  return v_invite.workspace_id;
end;
$$;

revoke all on function public.accept_workspace_invite(text) from public;
grant execute on function public.accept_workspace_invite(text) to authenticated, service_role;

-- Convenience sweep: flip any pending invite past its expiry to 'expired'.
-- Idempotent; intended to be run periodically (pg_cron / a server job) or before
-- listing invites. accept_workspace_invite() does NOT depend on this -- it gates
-- on expires_at directly -- so the stored status is purely cosmetic/queryable.
-- Returns the number of rows expired. SECURITY DEFINER so a server job using any
-- role (or a workspace admin) can run it without per-row RLS friction.
create or replace function public.expire_stale_workspace_invites()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.workspace_invites
    set status = 'expired'
    where status = 'pending'
      and expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.expire_stale_workspace_invites() from public;
grant execute on function public.expire_stale_workspace_invites() to service_role;

-- --- RLS --------------------------------------------------------------------
-- Workspace owners/admins manage invites for their own workspace; nobody else
-- can see them (no cross-tenant exposure). The accept flow does NOT rely on a
-- select policy -- it runs through the SECURITY DEFINER function above, so an
-- invitee who isn't yet a member never needs direct read access to the invite
-- (and we deliberately don't grant it, to avoid leaking who-was-invited).
-- Server-side invite creation + email send uses service_role, which bypasses RLS.
alter table public.workspace_invites enable row level security;

create policy workspace_invites_select on public.workspace_invites
  for select to authenticated
  using (public.is_workspace_admin(workspace_id));

create policy workspace_invites_insert on public.workspace_invites
  for insert to authenticated
  with check (public.is_workspace_admin(workspace_id));

create policy workspace_invites_update on public.workspace_invites
  for update to authenticated
  using (public.is_workspace_admin(workspace_id))
  with check (public.is_workspace_admin(workspace_id));

create policy workspace_invites_delete on public.workspace_invites
  for delete to authenticated
  using (public.is_workspace_admin(workspace_id));
