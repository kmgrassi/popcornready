-- Lift the typed-JSONB exclusion left in 20260610130000 for generation_runs.gates.
-- Target shape is a schema-marked object; the flat string-array bridge remains
-- accepted while callers finish moving off v1 stage names.
alter table public.generation_runs
  add constraint generation_runs_gates_schema_check
  check (
    (
      jsonb_typeof(gates) = 'object'
      and (gates ? 'schema' or gates ? 'schema_version')
    )
    or (
      jsonb_typeof(gates) = 'array'
      and not jsonb_path_exists(gates, '$[*] ? (@.type() != "string")')
    )
  ) not valid;
