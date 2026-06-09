alter table public.generation_runs
  add column if not exists review_feedback text;
