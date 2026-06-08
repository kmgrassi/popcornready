# Story Development & Agent Handoff — Scope

## Objective

Turn a raw creative concept into a durable **story-development chain** before
visual storyboarding or media generation.

The current product can already turn a brief into an `EditPlan` organized as
`Scenes -> Beats`, then generate rough storyboard panels from that plan. That is
useful for short ads and social videos, but it skips the richer writing layer a
movie-like prompt needs: premise, characters, arc, acts, scene summaries,
dialogue/narration, and ending.

This scope adds that missing layer as first-class product data. Reuse existing
project, brief, plan, composition, run-stage, and asset surfaces where they
already represent the right concept, but do **not** hide story/script state as
opaque JSON inside another lifecycle. Story blueprints and script drafts should
have dedicated tables because they are canonical creative artifacts the user and
agents will inspect, revise, branch, and pass downstream by ID.

## Product model

For a prompt like:

> A comedy set in space where explorers keep cloning themselves and nobody can
> keep track of who is who.

The first generated artifact should be the story structure, not a visual
storyboard image. The logical flow is:

```text
Brief / Concept
  -> Story Blueprint
  -> Script / Scene Draft
  -> Shot + Beat Plan
  -> Storyboard Sketches
  -> Keyframes / Clips / Audio
  -> Timeline / Critique / Export
```

Terminology matters:

- **Story blueprint**: the narrative plan. Premise, logline, tone, characters,
  arc, acts, ending, and constraints.
- **Script / scene draft**: scene-level written content. Scene summaries,
  dialogue, narration, comedic turns, emotional beats, and visual intent.
- **Shot + beat plan**: production structure. The existing `EditPlan` shape:
  scenes with ordered beats/shots, durations, mood, setting, and visual intent.
- **Storyboard sketches**: generated visual pre-viz panels. One `beat_storyboard`
  asset per beat, grouped by scene.

The landing page should not claim the full chain until the code executes and
persists it.

## Duration model

Duration is a structural input, not just a render setting. A 30-second ad, a
five-minute explainer, and a 90-minute movie should not produce the same prompt
shape with more beats. The requested timeframe must be threaded into every story
agent and should change the artifact granularity.

Current code already has partial duration plumbing:

- `VideoBriefInput.targetLengthSec` exists on brief versions.
- `planEdit()` receives `targetLengthSec` and asks beat durations to roughly sum
  to it.
- `CompositionPlan.plannedBeats[].durationSec` carries per-beat timing.
- Generated media accepts `durationSec`.
- Audio rewrite has an explicit target spoken duration.

The gap is that duration does not yet drive **story architecture**. The new
story agents should classify duration up front:

```ts
export type StoryDurationClass =
  | "micro"       // <= 30s: ad / short social
  | "short"       // 31s-2m: compact explainer / promo
  | "medium"      // 2m-10m: scene-based video / short episode
  | "long"        // 10m-45m: multi-sequence piece
  | "feature";    // 45m+: movie / long-form documentary

export interface StoryDurationPlan {
  targetLengthSec: number;
  durationClass: StoryDurationClass;
  expectedActCount: number;
  expectedSceneCount: number;
  expectedBeatCount: number;
  planningGranularity:
    | "beats_only"
    | "scenes_and_beats"
    | "acts_scenes_beats"
    | "sequences_acts_scenes_beats";
}
```

Recommended first-pass behavior:

| Target length | Story behavior | Production behavior |
| --- | --- | --- |
| `<= 30s` | One compact arc; optional script draft; 3-6 beats. | Generate beat panels directly after blueprint/plan. |
| `31s-120s` | Clear setup/escalation/payoff; lightweight scenes. | Scene+beat plan, storyboard per beat. |
| `2m-10m` | Script draft should run; multiple scenes with narration/dialogue. | Storyboard by scene; media generation can batch by scene. Requires user approval before asset generation. |
| `10m-45m` | Acts/sequences become required; script draft is required. | Generate scene/sub-video composites and stitch. Requires user approval before asset generation. |
| `45m+` | Feature structure; sequences/acts/scenes are required. | Long-video/feature execution is deferred. Requires recursive composition and parallel sub-video generation; not supported by current engine as a single flat run. |

The first implementation should keep existing short-form limits where provider
and run costs require them, but the data model should not encode a 600-second
ceiling as a product truth. If a request exceeds the current engine limit, the
story agent can still create a blueprint/script, while media generation returns a
typed precondition saying long-form composition support is required.

**Long-video note:** full feature-length generation is out of scope for this
workstream, but the model must preserve the idea that Popcorn Ready can grow into
long videos. Do not bake in short-form-only assumptions. The story/script layers
should be able to describe long-form structure even when the current media engine
declines to generate it.

**Approval rule:** for any requested video over 120 seconds, autonomous execution
must stop before expensive asset generation. The user must approve the story
blueprint, script draft, shot/beat plan, and storyboard/pre-viz assets before the
system spends on final keyframes, clips, audio, or renders. For shorter videos,
these gates may remain optional.

## Current state

### What exists and should be reused

- **Brief versions.** `brief_versions.brief` stores the user input as JSONB, and
  `VideoBriefInput` already includes goal, target length, aspect ratio, audience,
  style, narration script/asset, and constraints.
- **Project plan.** `projects.plan` already stores the editable storyboard plan
  (`EditPlan`) as JSONB. This is currently the durable `Scenes -> Beats` surface.
- **Plan model.** `EditPlan` has `scenes: Scene[]`; each `Scene` has setting,
  mood, optional character IDs, optional anchor asset ID, and `beats`.
- **Stable beat IDs.** Beats can carry stable IDs, which downstream assets and
  timeline segments should reference.
- **Composition plan.** `compositions` stores `planned_beats`, ready asset IDs,
  generated asset job IDs, and narration strategy. It is useful as the production
  readiness layer after the story/shot plan exists.
- **Generation runs and stage artifacts.** `generation_runs`,
  `generation_stages`, `generation_stage_items`, and
  `generation_stage_artifacts` already model stage order, review gates,
  per-stage status, and JSONB evidence payloads. Reuse them as run evidence and
  pointers to canonical story/script rows, not as the source of truth for
  story/script state.
- **Assets.** `assets.context` and `assets.provenance` already hold structured
  metadata, while pooled assets can represent generated storyboard tiles,
  keyframes, clips, audio, and references.
- **Agent calls.** Existing `planEdit`, `critiquePlan`, `selectClips`, and
  `critique` are single-shot structured LLM calls. They can be split and reused
  as leaf tools.

### What is missing

- No first-class **story blueprint** type.
- No first-class **script/scene draft** type.
- No explicit derivation chain:
  `briefVersionId -> storyBlueprintId -> scriptDraftId -> editPlan -> storyboard assets`.
- No agent-to-agent handoff protocol where each agent consumes durable artifact
  IDs instead of hidden prompt text.
- No orchestrator loop. Stage order is still mostly hardcoded, not chosen by an
  agent using validated tools.
- No regeneration vocabulary for story-level changes such as "change the
  ending", "make the protagonist less silly", or "rewrite scene 3 but keep the
  storyboard framing".

## Data model

Story blueprints and script drafts are not just transient run output. They are
the written creative plan of the project, so they deserve dedicated tables.

The reuse boundary is:

- Keep `brief_versions` as the immutable user/request input.
- Keep `projects.plan` as the current production shot/beat plan.
- Keep `compositions` as the generated/reused asset readiness plan.
- Keep `generation_stage_artifacts` as run evidence and UI/eval snapshots.
- Add dedicated `story_blueprints` and `script_drafts` as canonical story-writing
  resources.

### Shared types

Add typed contracts in `packages/shared/src/types.ts` or a dedicated shared story
module. These are both application contracts and the logical row payloads.

```ts
export interface StoryBlueprint {
  schemaVersion: "storyBlueprint.v1";
  id: string;
  projectId: string;
  briefVersionId: string;
  targetLengthSec: number;
  durationClass: StoryDurationClass;
  durationPlan: StoryDurationPlan;
  premise: string;
  logline?: string;
  genre?: string;
  tone?: string;
  audience?: string;
  theme?: string;
  storyArc: StoryArc;
  characters: StoryCharacter[];
  acts: StoryAct[];
  ending: string;
  constraints?: string[];
  createdAt: string;
  updatedAt: string;
  supersedesId?: string;
  status: "draft" | "approved" | "archived";
}

export interface StoryArc {
  setup: string;
  incitingIncident: string;
  escalation: string;
  crisis: string;
  resolution: string;
  button?: string;
}

export interface StoryCharacter {
  id: string;
  name: string;
  role: "protagonist" | "antagonist" | "supporting" | "background";
  description: string;
  motivation?: string;
  comedicFunction?: string;
  visualIdentity?: string;
}

export interface ScriptDraft {
  schemaVersion: "scriptDraft.v1";
  id: string;
  projectId: string;
  briefVersionId: string;
  storyBlueprintId: string;
  targetLengthSec: number;
  durationClass: StoryDurationClass;
  scenes: ScriptScene[];
  narration?: string;
  createdAt: string;
  updatedAt: string;
  supersedesId?: string;
  status: "draft" | "approved" | "archived";
}

export interface ScriptScene {
  id: string;
  actId?: string;
  name: string;
  setting: string;
  summary: string;
  characters: string[];
  dialogue?: DialogueLine[];
  narration?: string;
  visualIntent: string;
  emotionalTurn?: string;
  comedicTurn?: string;
}

export interface DialogueLine {
  characterId: string;
  text: string;
  delivery?: string;
}
```

### Tables

Add two canonical tables:

```sql
create table public.story_blueprints (
  id uuid primary key default gen_random_uuid(),
  schema_version text not null default 'storyBlueprint.v1',
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  brief_version_id uuid references public.brief_versions(id) on delete set null,
  supersedes_id uuid references public.story_blueprints(id) on delete set null,
  status text not null default 'draft',
  content jsonb not null,
  provenance jsonb not null default '{}'::jsonb,
  created_by jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index story_blueprints_project_id_idx on public.story_blueprints(project_id);
create index story_blueprints_brief_version_id_idx on public.story_blueprints(brief_version_id);

create table public.script_drafts (
  id uuid primary key default gen_random_uuid(),
  schema_version text not null default 'scriptDraft.v1',
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  brief_version_id uuid references public.brief_versions(id) on delete set null,
  story_blueprint_id uuid not null references public.story_blueprints(id) on delete cascade,
  supersedes_id uuid references public.script_drafts(id) on delete set null,
  status text not null default 'draft',
  content jsonb not null,
  provenance jsonb not null default '{}'::jsonb,
  created_by jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index script_drafts_project_id_idx on public.script_drafts(project_id);
create index script_drafts_story_blueprint_id_idx on public.script_drafts(story_blueprint_id);
```

The `content` JSONB should be the typed `StoryBlueprint` / `ScriptDraft` payload.
Keep acts, characters, scenes, and dialogue nested inside that content initially.
Do **not** create separate `acts`, `story_characters`, `script_scenes`, or
`dialogue_lines` tables until there is a concrete relational query, collaboration
feature, or partial-update workflow that needs them.

Add RLS policies following the existing project-owned table pattern:

- owner/member read/write via `owns_project(project_id)`
- public read only when project visibility allows it, matching existing content
  visibility rules if public story artifacts ever surface

### Project-level current pointers

For editor reloads and "current draft" UX, add current pointers to `projects`
instead of deriving from the latest run:

```sql
alter table public.projects
  add column current_story_blueprint_id uuid references public.story_blueprints(id) on delete set null,
  add column current_script_draft_id uuid references public.script_drafts(id) on delete set null;
```

The run can still write stage artifacts, but the stage artifact should include
the canonical row ID and optionally a snapshot:

```ts
type StoryStageArtifact =
  | {
      kind: "story_blueprint";
      storyBlueprintId: string;
      snapshot: StoryBlueprint;
    }
  | {
      kind: "script_draft";
      scriptDraftId: string;
      storyBlueprintId: string;
      snapshot: ScriptDraft;
    };
```

If the existing `stage_item_kind` enum makes that awkward, add
`story_blueprint` and `script_draft` to it rather than pretending these are
`timeline` artifacts.

## Agent handoff model

Each agent writes a durable story resource and passes IDs forward. The next
agent receives structured content plus provenance, not an implicit prose summary.

```text
Story Agent
  input: BriefVersion + targetLengthSec
  output: StoryBlueprint row

Script Agent
  input: BriefVersion + StoryBlueprint row + duration plan
  output: ScriptDraft row

Shot Planner Agent
  input: BriefVersion + StoryBlueprint + ScriptDraft + duration plan
  output: EditPlan persisted to projects.plan and stage artifact

Storyboard Agent
  input: EditPlan
  output: beat_storyboard assets, one per beat

Media Agent
  input: approved EditPlan + storyboard assets + asset pool
  output: beat_keyframe, beat_clip, audio assets

Editor Agent
  input: plan + generated assets
  output: VersionedTimeline + EditGraph

Critic Agent
  input: timeline + upstream story/script/plan IDs + pool
  output: patch decisions or regeneration requests
```

The handoff payload should look like this:

```ts
interface AgentHandoff<TInputRefs extends Record<string, string>> {
  projectId: string;
  briefVersionId: string;
  inputRefs: TInputRefs;
  resourceIds: string[];
  constraints: {
    targetLengthSec?: number;
    durationClass?: StoryDurationClass;
    aspectRatio?: string;
    budgetUsd?: number;
    reviewGates?: string[];
  };
}
```

This can be implemented without a full orchestrator loop at first: the engine can
still call the agents in a fixed order, as long as each stage persists the
resource and the next stage consumes it by ID. The orchestrator-tools lane can
later replace the fixed order with tool selection and self-healing.

## Stage changes

Add two stages before `creative_plan`:

```text
brief_intake
  -> story_development
  -> script_planning
  -> creative_plan
  -> storyboard
  -> asset_generation
  -> audio_generation
  -> timeline_assembly
  -> quality_review
  -> export
  -> ready
```

For short prompt-to-ad runs, `script_planning` can be skipped or collapse into a
minimal scene draft. For movie-like concepts, it should run by default.

New `GenerationStageType` values:

- `story_development`
- `script_planning`

Both should be gateable. Reviewing the story blueprint is cheaper and more
valuable than reviewing generated video after the wrong story has already been
made.

For runs where `targetLengthSec > 120`, these gates are mandatory:

- `story_development`
- `script_planning`
- `creative_plan`
- `storyboard`

`asset_generation` must not start until all mandatory pre-asset gates are
approved. The storyboard gate should include generated sketch panels and any
reference/anchor images that will materially steer the final video.

## API shape

Add granular endpoints, following the existing `/projects/:projectId/plan`
pattern:

```text
POST /projects/:projectId/story-blueprint
GET  /projects/:projectId/story-blueprint/:jobId

POST /projects/:projectId/script-draft
GET  /projects/:projectId/script-draft/:jobId
```

Request bodies:

```ts
type CreateStoryBlueprintRequest =
  | { prompt: string; targetLengthSec: number; style?: string; aspectRatio?: string }
  | { briefVersionId: string };

interface CreateScriptDraftRequest {
  briefVersionId: string;
  storyBlueprintId: string;
  targetDetail?: "outline" | "scene_summaries" | "dialogue";
}
```

Responses should return a pollable job and include the generated row ID on
success.

## Derivation and selective regeneration

The derivation chain should be explicit:

```text
BriefVersion
  -> StoryBlueprint
  -> ScriptDraft
  -> EditPlan scenes/beats
  -> beat_storyboard assets
  -> beat_keyframe assets
  -> beat_clip assets
  -> Timeline/EditGraph
```

Minimum provenance fields for story/script artifacts:

```ts
interface StoryArtifactProvenance {
  briefVersionId: string;
  parentArtifactIds: string[];
  model?: { provider: string; model?: string };
  promptVersion: string;
  generatedAt: string;
}
```

Later, when provenance-graph consumes these artifacts, changes can target the
right downstream work:

- Change premise/theme -> re-run story, script, plan, storyboard, media.
- Change dialogue only -> re-run script, narration/audio, captions, maybe no
  visual regeneration.
- Change scene setting -> re-run affected `EditPlan` scene, storyboard panels,
  keyframes/clips for that scene.
- Change one beat intent -> re-run one beat's storyboard/keyframe/clip and
  reassemble the timeline.

## PR breakdown

1. **Shared story contracts.**
   Add `StoryBlueprint`, `ScriptDraft`, `ScriptScene`, and provenance types.
   Add schemas for structured LLM output. Include `StoryDurationClass` and
   `StoryDurationPlan`.

2. **Story agent.**
   Add `developStoryBlueprint()` as a structured LLM call. It must receive
   `targetLengthSec`, classify the duration, and choose act/scene/beat
   granularity from that duration plan. Persist its output to
   `story_blueprints` and attach the row to the generation stage.

3. **Script agent.**
   Add `draftScriptScenes()` consuming a story blueprint row. Its prompt must
   receive the target duration and duration plan. Persist output to
   `script_drafts`. Keep dialogue optional for short formats and required for
   narrative long-form classes.

4. **Plan from script.**
   Split current `planEdit()` into `planShotsFromStory()` for the new path while
   keeping the old prompt-to-plan call as a compatibility shortcut. Persist the
   resulting `EditPlan` to `projects.plan` and stage artifacts.

5. **Run stages.**
   Add `story_development` and `script_planning` to generation stage types, stage
   order, labels, payload seeding, progress UI, and review gates. Enforce
   mandatory pre-asset gates for `targetLengthSec > 120`.

6. **Granular API endpoints.**
   Add story/script endpoints that mirror the plan endpoint's async job shape and
   typed precondition errors.

7. **Story-aware regeneration scope.**
   Define regeneration actions for `change_story_blueprint`,
   `rewrite_script_scene`, and `replan_scene`, but leave actual orchestrator tool
   selection to the orchestrator-tools lane.

## Open decisions

- Should `script_planning` run for every prompt, or only when the requested
  length/format implies narrative complexity?
- What are the first supported hard limits for media generation? The story layer
  can model feature-length work, but the current flat media engine should return
  a typed "long-form composition required" error rather than pretending it can
  render 90 minutes.
- Should the 120-second approval threshold be configurable by workspace, or fixed
  globally for the hosted product?
- Should `generation_stage_artifacts.kind` grow beyond the current
  `stage_item_kind` enum to include `story_blueprint` and `script_draft`, or
  should we initially store these as `timeline` artifacts to avoid a migration?
- How much dialogue should the script agent write before visual generation?
- Should character profiles be auto-created from `StoryCharacter` entries, or
  remain a separate explicit user/agent action?

## Acceptance criteria

- A movie-like prompt can produce a persisted `StoryBlueprint` before any
  storyboard or media generation.
- The story blueprint and script draft both record `targetLengthSec`,
  `durationClass`, and the derived duration plan.
- Story/script/shot-planning prompts all receive the target duration and change
  granularity based on it.
- A `ScriptDraft` can be generated from that blueprint and inspected through the
  run stage that created it.
- The shot/beat planner consumes the script artifact instead of only the raw
  brief.
- Existing short-form prompt-to-plan flows still work.
- The run UI can pause for review after story development or script planning.
- For `targetLengthSec > 120`, the engine requires approval of story blueprint,
  script draft, shot/beat plan, and storyboard/pre-viz before `asset_generation`
  can start.
- `story_blueprints` and `script_drafts` are canonical tables; generation stage
  artifacts only reference or snapshot them.
