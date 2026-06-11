-- Wire the 'poster' asset kind (added in 20260611000000) into the shape
-- constraint and the agent-legible ref prefixes. Posters are images.

alter table public.assets drop constraint assets_kind_media;
alter table public.assets add constraint assets_kind_media check (
  (kind in ('brief','beat','narration_script','critique','plan','composite')
     and media = 'data')
  or (kind in ('anchor','keyframe','poster') and media = 'image')
  or (kind = 'audio_track' and media = 'audio')
  or (kind = 'clip' and media = 'video')
  or (kind in ('source_footage','render') and media <> 'data')
);

create or replace function public.assets_set_ref()
returns trigger
language plpgsql
as $$
begin
  if new.ref is null then
    new.ref :=
      case new.kind
        when 'source_footage'   then 'src'
        when 'brief'            then 'brief'
        when 'beat'             then 'beat'
        when 'anchor'           then 'anc'
        when 'keyframe'         then 'kf'
        when 'clip'             then 'clip'
        when 'audio_track'      then 'aud'
        when 'narration_script' then 'narr'
        when 'critique'         then 'crit'
        when 'plan'             then 'plan'
        when 'composite'        then 'cut'
        when 'render'           then 'rend'
        when 'poster'           then 'poster'
      end || '_' || substr(md5(gen_random_uuid()::text), 1, 6);
  end if;
  return new;
end;
$$;
