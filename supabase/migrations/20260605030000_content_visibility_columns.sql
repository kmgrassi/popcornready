-- User tiers/content visibility PR 3: visibility metadata on consumable rows.
--
-- This only adds the visibility shape from docs/scopes/user-tiers-content-visibility.md.
-- RLS public-read policies, tier enforcement, discovery indexes, and saved-assets
-- bookmarks are separate slices.

create type public.visibility as enum ('public', 'private');

alter table public.projects
  add column visibility public.visibility not null default 'public';

alter table public.assets
  add column visibility public.visibility not null default 'public',
  add column storage_bucket text;

comment on column public.projects.visibility is
  'Public/private discovery visibility. Free-owner content is public; paid-owner defaults and tier enforcement are applied by later visibility slices.';

comment on column public.assets.visibility is
  'Asset-level public/private visibility. Effective public access also requires the owning project to be public.';

comment on column public.assets.storage_bucket is
  'Physical object bucket for delivery. This tracks effective asset visibility once the S3/CloudFront storage toggle is wired.';

create index projects_visibility_idx
  on public.projects (visibility)
  where visibility = 'public';

create index assets_visibility_idx
  on public.assets (visibility)
  where visibility = 'public';

-- Existing assets were written to the current private Supabase `assets` bucket.
-- Keep that physical location explicit until the storage toggle/cascade slice
-- creates new public/private buckets and moves bytes between them.
update public.assets
set storage_bucket = 'assets'
where storage_bucket is null
  and storage_key is not null;
