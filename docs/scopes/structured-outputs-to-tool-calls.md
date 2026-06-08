# Structured Outputs to Tool Calls — Scope

## Goal

Move Popcorn Ready's model-facing generation flow from fixed server sequencing
with one-shot structured JSON outputs to an orchestrator-driven tool-call loop.

This scope applies to the whole model-facing generation stack, not only the
storyboard handoff. The story-development flow is the first concrete path that
needs the new contracts, but the migration target covers every agent that
currently returns JSON into a fixed server sequence:

- Story Agent
- Script Agent
- Shot Planner Agent
- Visual Anchor Planner
- Storyboard Agent
- Media-generation planning/review agents
- Audio/Narration Agent
- Editor/Timeline Agent
- Critic/Revision Agent

Provider adapters such as image, video, audio, render, and export are not
"agents," but they should also be wrapped as server-owned tools so the
orchestrator can call them, wait on them asynchronously, and receive structured
errors.

Today the server decides the order:

```text
server route/engine
  -> structuredCall(prompt + JSON schema)
  -> JSON object
  -> server persists result
  -> server calls next hardcoded step
```

The target flow lets the orchestrator agent decide what server-owned tool to call
next, while the server still owns validation, persistence, jobs, authorization,
provider execution, and stage state:

```text
orchestrator run
  -> model emits typed tool call
  -> server validates and starts/runs tool
  -> server records tool result or async job
  -> orchestrator resumes with result/error
  -> model emits next tool call
```

This does not mean the database is mutated by model code. Tool handlers mutate
storage. The model emits typed tool calls; tools return typed results.

## Why change

Structured JSON outputs are good for leaf artifacts like an `EditPlan`, but they
do not let the model react to the system. When a provider fails, an anchor is
missing, a budget is exceeded, or a user rejects a stage, fixed server code has
to know every branch up front.

Tool calls give the model a constrained action surface:

- The model can only call named tools with declared input schemas.
- Tool handlers can validate preconditions before spending money.
- Tool errors can be fed back into the model as first-class context.
- The model can self-heal by calling another tool, changing inputs, or pausing
  for approval.
- The same tool contract can support autonomous runs, gated runs, retries, and
  selective regeneration.

## Current state

Current agent helpers such as `planEdit`, `critiquePlan`, `selectClips`,
`critique`, `revise`, and `rewriteNarrationScript` are stateless structured
model calls. They use `structuredCall(...)` with an output JSON schema. The
server parses the JSON and the route/engine decides the next step.

There are route-level and helper-level seams that already look tool-like:

- v1 plan endpoints wrap `planEdit` in a pollable job shape.
- beat media endpoints return structured precondition errors.
- generation helpers already persist assets and provider metadata.
- provenance and asset-pool work gives downstream tools stable IDs to reason
  about.

But the model is not currently emitting tool calls to drive the flow. Ordering
is still fixed in server code.

## Target principles

1. **Tools are server-owned.** A tool validates inputs, checks auth, estimates
   cost, mutates storage, records provenance, and returns a typed result.
2. **The model chooses from a small vocabulary.** The orchestrator agent can call
   only registered tools with typed schemas.
3. **Long work is asynchronous.** Tool calls may return `accepted` with a job ID.
   The orchestrator run pauses until that job reaches a terminal state.
4. **Every transition is durable.** A model/tool turn can be replayed from
   persisted `orchestrator_runs`, `tool_invocations`, jobs, artifacts, and stage
   rows.
5. **Errors are model-readable.** Precondition misses, provider failures,
   policy blocks, budget limits, and user rejections return structured errors
   that the next model turn can reason over.
6. **Structured outputs still exist inside tools.** A tool like
   `develop_story_blueprint` can call a leaf Story Agent that returns JSON. The
   difference is that the orchestrator chooses and observes the tool, while the
   tool owns persistence and validation.

## Async tool-call model

Tool calling is not always a single request/response. Media generation, review
gates, export, and long storyboard runs may finish minutes later. Treat tool
calls as durable invocations with explicit lifecycle.

```ts
type ToolInvocationStatus =
  | "requested"
  | "running"
  | "waiting_for_job"
  | "waiting_for_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

type ToolCallResult =
  | {
      status: "succeeded";
      resourceIds: string[];
      artifactIds?: string[];
      costUsd?: number;
      output?: unknown;
    }
  | {
      status: "accepted";
      jobId: string;
      resumesWhen: "job_terminal";
      estimatedCostUsd?: number;
    }
  | {
      status: "waiting_for_approval";
      gateId: string;
      resumesWhen: "approval_terminal";
      previewArtifactIds: string[];
    }
  | {
      status: "failed";
      error: ToolError;
    };
```

When a tool returns `accepted`, the model turn ends. The run driver subscribes to
job completion or polls it. When the job reaches `succeeded` or `failed`, the
driver starts a new model turn with the prior tool result in context.

This is the important behavior change: the "next run" does not happen in the
same call stack. It resumes from durable state after the previous invocation is
finalized.

## Orchestrator run state

Add a durable run layer for the model/tool loop:

```ts
interface OrchestratorRun {
  id: string;
  projectId: string;
  generationRunId?: string;
  status: "running" | "waiting" | "succeeded" | "failed" | "cancelled";
  currentTurnId?: string;
  waitingOn?: {
    kind: "tool_job" | "approval_gate";
    id: string;
  };
  budget?: {
    maxUsd?: number;
    spentUsd: number;
    proposedUsd: number;
  };
  createdAt: string;
  updatedAt: string;
}

interface OrchestratorTurn {
  id: string;
  orchestratorRunId: string;
  inputSummary: string;
  model: string;
  toolCalls: ToolInvocation[];
  terminalReason: "tool_requested" | "waiting" | "done" | "error";
  createdAt: string;
}

interface ToolInvocation {
  id: string;
  orchestratorRunId: string;
  turnId: string;
  toolName: ToolName;
  input: unknown;
  status: ToolInvocationStatus;
  jobId?: string;
  gateId?: string;
  result?: ToolCallResult;
  error?: ToolError;
  createdAt: string;
  updatedAt: string;
}
```

This may be backed by existing generation-run/job/stage tables at first, but the
orchestrator needs its own durable turn log so it can resume after async work,
audit decisions, and replay context without relying on in-memory state.

## Tool result and error contract

Every tool result should be shaped for the next model turn. Errors should name
what happened, whether it is recoverable, and which tools could satisfy it.

```ts
type ToolErrorKind =
  | "precondition_unmet"
  | "invalid_input"
  | "provider_quota"
  | "provider_failed"
  | "budget_exceeded"
  | "approval_rejected"
  | "policy_violation"
  | "timeout";

interface ToolError {
  kind: ToolErrorKind;
  message: string;
  recoverable: boolean;
  retryAfterSec?: number;
  unmetRequirements?: PreconditionMiss[];
  suggestedNextTools?: SuggestedToolCall[];
  details?: Record<string, unknown>;
}

interface PreconditionMiss {
  requirement: string;
  because: string;
  satisfyWith: SuggestedToolCall;
}

interface SuggestedToolCall {
  tool: ToolName;
  inputHint: Record<string, unknown>;
}
```

Example:

```json
{
  "kind": "precondition_unmet",
  "message": "Beat beat_03 uses character char_captain but no active character anchor exists.",
  "recoverable": true,
  "unmetRequirements": [
    {
      "requirement": "character_anchor",
      "because": "The clip prompt references a recurring main character.",
      "satisfyWith": {
        "tool": "generate_anchor",
        "inputHint": {
          "characterId": "char_captain",
          "anchorRole": "character_anchor"
        }
      }
    }
  ]
}
```

The orchestrator can then call `generate_anchor`, wait for it to finish, and
retry `generate_media` with the new anchor ID.

## Initial tool vocabulary

Start with a small set that maps to current and scoped generation stages:

```ts
type ToolName =
  | "create_or_load_brief"
  | "develop_story_blueprint"
  | "draft_script"
  | "plan_shots"
  | "plan_visual_anchors"
  | "generate_anchor"
  | "generate_storyboard"
  | "generate_keyframe"
  | "generate_clip"
  | "generate_audio"
  | "assemble_timeline"
  | "critique_timeline"
  | "request_approval"
  | "export_video";
```

Each tool should declare:

- input schema
- output schema
- required project/asset/beat/story IDs
- precondition validation
- estimated cost
- whether it is sync, async, or approval-gated
- resources it produces
- provenance edges it records

## Flow example

For the prompt "a comedy set in space where explorers keep cloning themselves":

```text
Turn 1:
  model calls create_or_load_brief
  tool persists briefVersionId

Turn 2:
  model calls develop_story_blueprint
  tool returns accepted(jobId)
  run waits

Resume after job succeeds:
  model receives storyBlueprintId
  model calls draft_script
  tool returns accepted(jobId)
  run waits

Resume:
  model calls plan_shots
  tool persists scenes/beats with IDs

Resume:
  model calls plan_visual_anchors
  tool identifies recurring explorers and spaceship setting

Resume:
  model calls generate_anchor for main explorer
  model calls generate_anchor for spaceship interior
  tools return accepted(jobIds)
  run waits for both jobs

Resume:
  model calls generate_storyboard for each beat
  tools return storyboard asset IDs

If targetLengthSec > 120:
  model calls request_approval for pre-asset gate
  run waits until user approves or rejects

Resume after approval:
  model calls generate_keyframe/generate_clip/generate_audio
  tools return accepted(jobIds)
  run waits

Resume:
  model calls assemble_timeline
  model calls critique_timeline
  if critic requests fixes, model calls targeted regenerate/reassemble tools
  model calls export_video
```

## Approval gates

Approvals become explicit tool calls or tool results, not hidden server pauses.

For short videos, the orchestrator may run without approval unless the user
configured gates. For videos over 120 seconds, the orchestrator must request
approval before expensive media generation for:

- story blueprint
- script draft
- shot/beat plan
- visual anchors
- storyboard/pre-viz

If the user rejects a gate, the gate result is passed back to the model:

```json
{
  "kind": "approval_rejected",
  "message": "User rejected storyboard gate with note: make the clone confusion clearer by scene 2.",
  "recoverable": true,
  "suggestedNextTools": [
    {
      "tool": "plan_shots",
      "inputHint": {
        "revisionInstruction": "Make clone confusion visually clear by scene 2."
      }
    }
  ]
}
```

The orchestrator chooses whether to revise the story, script, shot plan,
anchors, storyboard, or only affected media.

## Migration plan

### PR 1 — Tool registry and result envelope

Add a server-side registry with tool definitions, input parsing, auth context,
cost estimate hooks, and the `ToolCallResult` / `ToolError` envelope. Wrap one
cheap existing function, likely `planEdit`, as `plan_shots`.

No model tool loop yet. This PR proves the tool contract can run from normal
server code.

### PR 2 — Durable tool invocations

Persist `orchestrator_runs`, `orchestrator_turns`, and `tool_invocations`, or
map them onto existing run/job tables if the store-consolidation layer is ready.
The important behavior is durable async resume:

- start tool invocation
- attach job or gate ID
- mark invocation terminal when the job/gate completes
- resume the orchestrator from persisted state

### PR 3 — Async bridge for one media tool

Wrap one expensive media operation, likely `generate_clip`, as an async tool.
Return `accepted(jobId)` immediately, then resume after job completion. Feed
provider quota/failure errors back through `ToolError`.

### PR 4 — Model tool loop behind a flag

Add the orchestrator model call with the initial tool vocabulary, but keep it
behind a feature flag. The model can call one tool per turn at first. The run
driver executes or waits, then starts the next turn.

### PR 5 — Error self-heal

Teach tools to return actionable `precondition_unmet`, `provider_quota`,
`budget_exceeded`, and `approval_rejected` errors. Feed those back into the
model and allow the orchestrator to call suggested recovery tools.

### PR 6 — Story flow migration

Move the story-development path onto the tool loop:

- `develop_story_blueprint`
- `draft_script`
- `plan_shots`
- `plan_visual_anchors`
- `request_approval`
- `generate_storyboard`
- media tools
- assembly/review/export

Keep the old fixed engine available as a fallback until the tool loop is stable.

## Open questions

- Should the orchestrator be allowed to issue multiple independent tool calls in
  one turn, or should PR 4 enforce one tool call per turn for simpler recovery?
- Which tables own the durable turn log after store consolidation lands?
- Do provider webhooks exist for every async media job, or do we need a polling
  worker for some providers?
- How much tool output should be summarized back to the model versus referenced
  by ID to keep context small?
- Should budget approval be separate from normal review gates, or should it be a
  specialized `request_approval` gate?

## Acceptance criteria

- The scope distinguishes current structured JSON calls from target tool calls.
- Tool calls are durable and can wait for async jobs or approval gates.
- A completed tool invocation can resume the orchestrator without in-memory
  state.
- Tool errors are structured, recoverable where possible, and visible to the
  next model turn.
- Structured JSON leaf agents remain valid inside tool handlers.
- The story-development flow can migrate incrementally without blocking the
  current fixed server sequence.
