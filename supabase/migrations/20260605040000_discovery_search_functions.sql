-- Public discovery search RPCs for the Express API.
--
-- Tier, visibility, public-read policies, and baseline discovery indexes are
-- created by 20260605000000_user_tiers_visibility.sql.

create or replace function public.search_public_projects(search_query text)
returns setof public.projects
language sql
stable
security definer
set search_path = public
as $$
  select p.*
  from public.projects p
  where p.visibility = 'public'
    and p.status <> 'deleted'
    and to_tsvector(
      'english',
      coalesce(p.name, '') || ' ' ||
      coalesce(p.brief ->> 'summary', '') || ' ' ||
      coalesce(p.brief ->> 'goal', '')
    ) @@ plainto_tsquery('english', search_query)
  order by p.created_at desc, p.id desc
$$;

revoke all on function public.search_public_projects(text) from public;
grant execute on function public.search_public_projects(text)
  to anon, authenticated, service_role;

create or replace function public.search_public_assets(
  search_query text,
  asset_kind_filter public.asset_kind default null
)
returns setof public.assets
language sql
stable
security definer
set search_path = public
as $$
  select a.*
  from public.assets a
  join public.projects p on p.id = a.project_id
  where a.visibility = 'public'
    and p.visibility = 'public'
    and p.status <> 'deleted'
    and (asset_kind_filter is null or a.kind = asset_kind_filter)
    and to_tsvector(
      'english',
      coalesce(a.description, '') || ' ' ||
      coalesce(a.context ->> 'summary', '') || ' ' ||
      coalesce(a.context #>> '{context,summary}', '') || ' ' ||
      coalesce(a.context #>> '{agentContext,summary}', '') || ' ' ||
      coalesce(a.context #>> '{clipUnderstanding,combinedSummary}', '') || ' ' ||
      coalesce(a.context #>> '{context,transcriptText}', '') || ' ' ||
      coalesce(a.semantic_analysis::text, '')
    ) @@ plainto_tsquery('english', search_query)
  order by a.created_at desc, a.id desc
$$;

revoke all on function public.search_public_assets(text, public.asset_kind) from public;
grant execute on function public.search_public_assets(text, public.asset_kind)
  to anon, authenticated, service_role;
