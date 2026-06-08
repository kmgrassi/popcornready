-- User-tier/content-visibility PR 7: thin bookmark table for saved public assets.
--
-- A saved asset is a user-owned pointer to a source asset. It does not copy
-- bytes; the later consume/add-to-project flow is responsible for revalidating
-- effective public visibility before copying.

create table public.saved_assets (
  user_id         uuid not null references public.users (id) on delete cascade,
  source_asset_id text not null references public.assets (id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (user_id, source_asset_id)
);

create index saved_assets_source_asset_id_idx
  on public.saved_assets (source_asset_id);

alter table public.saved_assets enable row level security;

create policy saved_assets_own on public.saved_assets
  for all to authenticated
  using (user_id = public.current_app_user_id())
  with check (user_id = public.current_app_user_id());
