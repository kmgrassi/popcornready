# Orchestrator Tool-Call Smoke Tests

These manual tests call the real configured LLM provider and verify that the
model emits an actual tool call with the exact input shape requested by the
orchestrator loop. The tool handler is a local probe that only echoes input, so
these tests spend model tokens but do not run media generation, export, storage,
or other expensive handlers.

## Requirements

- OpenAI probes require `OPENAI_API_KEY`.
- Anthropic probes require `ANTHROPIC_API_KEY`.
- Optional model overrides use the normal API env vars:
  `OPENAI_MODEL`, `OPENAI_FAST_MODEL`, `ANTHROPIC_MODEL`, and
  `ANTHROPIC_FAST_MODEL`.

## Commands

Run every orchestrator tool against the provider selected by `LLM_PROVIDER`
(`openai` by default):

```bash
pnpm --filter @popcorn/api smoke:tool-calls
```

Run every orchestrator tool against both LLM adapters:

```bash
pnpm --filter @popcorn/api smoke:tool-calls -- --provider all
```

Run one tool against one provider while iterating:

```bash
pnpm --filter @popcorn/api smoke:tool-calls -- --provider openai --tool plan_shots
pnpm --filter @popcorn/api smoke:tool-calls -- --provider anthropic --tool generate_clip
```

## What It Checks

For each tool in the orchestrator vocabulary, the runner exposes only that tool
to the model with a schema requiring:

- `projectId: "proj_tool_call_probe"`
- `toolName: "<expected tool name>"`
- `confirmationToken: "<per-run random token>"`

The command fails if the model returns text instead of a tool call, selects the
wrong tool, omits any required input, or changes one of the sentinel values.
