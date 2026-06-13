# Orchestrator tool-call test harness

A **manual** rig for verifying that the agent uses each orchestrator tool
correctly: given a natural-language instruction, does the model call the right
tool with **schema-valid input**, and does the real handler's database write
succeed? Each case runs **end-to-end** against a real model and a real, throwaway
Postgres sandbox, then tears the sandbox down.

This is the verification rig for the North Star migration: as each of the 14
orchestrator tools gets wired to a live handler, fill in its battery and prove it
here before relying on it. Today only `plan_shots` and `create_or_load_brief` are
wired; the other 12 ship as `pending` placeholders.

> Manual + opt-in: cases make real LLM calls and write real rows. The endpoint is
> dev-flag-gated and never mounts in production.

## How it works

```
CLI (scripts/tool-tests.ts) ──HTTP──▶ POST /api/v1/dev/tool-tests/run
  per case:  createSandbox (throwaway workspace + project)
          →  model picks ONE tool (real orchestratorModel)
          →  real handler executes (real INSERT)
          →  assertions (tool chosen, input/output match, result status, verify)
          →  teardownSandbox (delete workspace; FK-cascades the rest)
```

Teardown is safe: the sandbox workspace is uniquely named `__tooltest__<uuid>`,
and teardown refuses any name without that prefix. A sweeper removes orphans from
crashed runs at the start of each suite.

## Running it

Start the dev API with the harness enabled:

```sh
NODE_ENV=development AUTH_MODE=local ENABLE_TOOL_TEST_HARNESS=1 pnpm dev:api
```

(`.env.local` must provide `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and an LLM
provider key.) Then, from another shell:

```sh
pnpm --filter @popcorn/api test:tools -- --list
pnpm --filter @popcorn/api test:tools -- --tool create_or_load_brief
pnpm --filter @popcorn/api test:tools -- --tool plan_shots --provider anthropic
pnpm --filter @popcorn/api test:tools -- --tool create_or_load_brief --keep   # skip teardown
```

## Adding a battery

One file per tool lives in `specs/`. To add cases for a tool you just wired,
replace its `pendingBattery(...)` with real `active` cases:

```ts
export const myToolBattery: ToolBattery = {
  tool: "my_tool",
  cases: [
    {
      name: "does the thing and persists it",
      instruction: "Natural-language ask handed to the model.",
      expect: {
        callStatus: "succeeded",          // or ["succeeded", "failed"]
        input: { aspectRatio: "9:16" },   // deep-subset match on model input
        output: { /* deep-subset match on a succeeded result.output */ },
      },
      verify: async ({ sandbox, db, result, actualInput }) => {
        // Query the sandbox via the service client; return [] to pass,
        // or a list of failure strings.
        const failures: string[] = [];
        // ...
        return failures;
      },
    },
  ],
};
```

Then import it in `batteries.ts`. A startup check fails loudly if any vocabulary
tool lacks a battery.

### Case fields

| field | meaning |
| --- | --- |
| `instruction` | the turn's input summary handed to the model |
| `availableTools` | `"only"` (default — isolate the tool) or `"all"` (test tool *selection*) |
| `status` | `"active"` (default) or `"pending"` (skipped — tool not wired) |
| `expect.tool` | tool the model should call (defaults to the battery's tool) |
| `expect.callStatus` | acceptable result status(es); default `"succeeded"` |
| `expect.input` / `expect.output` | deep-subset matches |
| `verify` | custom hook for DB/state assertions; returns failure strings |

## Files

| file | role |
| --- | --- |
| `types.ts` | battery / case / report types |
| `assertions.ts` | pure deep-subset matcher (unit tested) |
| `bridge.ts` | adapts the real `orchestrator-tools` registry to the driver registry |
| `sandbox.ts` / `sandbox-guard.ts` | throwaway workspace lifecycle + delete guard |
| `runner.ts` | runs a case/suite end-to-end |
| `batteries.ts` | aggregates all 14 batteries |
| `specs/*.ts` | one battery per tool |
