-- Backfill schema markers for legacy asset-graph JSONB payloads, then validate
-- the typed JSONB constraints added in 20260610130000.
--
-- This is intentionally additive: the constraints are already present as
-- NOT VALID in the linked database, and applied migrations must not be edited.

alter table public.assets disable trigger assets_guard_immutable;
alter table public.assets disable trigger assets_set_updated_at;
alter table public.actions disable trigger actions_guard_immutable;
alter table public.actions disable trigger actions_set_updated_at;

update public.assets
set
  content =
    case
      when content is not null
        and jsonb_typeof(content) = 'object'
        and not (content ? 'schema' or content ? 'schema_version')
      then jsonb_build_object(
        'schema_version',
        case kind
          when 'brief' then 'brief.v1'
          when 'plan' then 'plan.v1'
          else kind::text || '.v1'
        end
      ) || content
      else content
    end,
  params =
    case
      when params is not null
        and params <> '{}'::jsonb
        and jsonb_typeof(params) = 'object'
        and not (params ? 'schema' or params ? 'schema_version')
      then jsonb_build_object('schema_version', 'asset_params.v1') || params
      else params
    end
where (
    content is not null
    and jsonb_typeof(content) = 'object'
    and not (content ? 'schema' or content ? 'schema_version')
  )
  or (
    params is not null
    and params <> '{}'::jsonb
    and jsonb_typeof(params) = 'object'
    and not (params ? 'schema' or params ? 'schema_version')
  );

update public.actions
set
  params =
    case
      when params <> '{}'::jsonb
        and jsonb_typeof(params) = 'object'
        and not (params ? 'schema' or params ? 'schema_version')
      then jsonb_build_object('schema_version', 'action_params.v1') || params
      else params
    end,
  proposal =
    case
      when proposal is not null
        and jsonb_typeof(proposal) = 'object'
        and not (proposal ? 'schema' or proposal ? 'schema_version')
      then jsonb_build_object('schema_version', 'action_proposal.v1') || proposal
      else proposal
    end,
  error =
    case
      when error is not null
        and jsonb_typeof(error) = 'object'
        and not (error ? 'schema' or error ? 'schema_version')
      then jsonb_build_object('schema_version', 'action_error.v1') || error
      else error
    end
where (
    params <> '{}'::jsonb
    and jsonb_typeof(params) = 'object'
    and not (params ? 'schema' or params ? 'schema_version')
  )
  or (
    proposal is not null
    and jsonb_typeof(proposal) = 'object'
    and not (proposal ? 'schema' or proposal ? 'schema_version')
  )
  or (
    error is not null
    and jsonb_typeof(error) = 'object'
    and not (error ? 'schema' or error ? 'schema_version')
  );

alter table public.actions enable trigger actions_guard_immutable;
alter table public.actions enable trigger actions_set_updated_at;
alter table public.assets enable trigger assets_guard_immutable;
alter table public.assets enable trigger assets_set_updated_at;

alter table public.assets validate constraint assets_content_schema_check;
alter table public.assets validate constraint assets_params_schema_check;
alter table public.actions validate constraint actions_params_schema_check;
alter table public.actions validate constraint actions_proposal_schema_check;
alter table public.actions validate constraint actions_error_schema_check;
