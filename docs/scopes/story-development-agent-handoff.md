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
- **Partial visual-anchor primitives.** `character_anchor` assets exist, the
  asset role vocabulary includes `scene_anchor`, `Scene.anchorAssetId` can point
  at an establishing image, and storyboard/keyframe generation can carry anchor
  IDs as provenance inputs. Existing docs already point toward conditional use:
  scenes carry `characterIds` and optional `anchorAssetId`, generated assets
  record `anchorIds`, and tool validation can require a character anchor only
  when a beat declares a main character.
- **Agent calls.** Existing `planEdit`, `critiquePlan`, `selectClips`, and
  `critique` are single-shot structured LLM calls. They can be split and reused
  as leaf tools.

### What is missing

- No first-class **story blueprint** type.
- No first-class **script/scene draft** type.
- No explicit derivation chain:
  `briefVersionId -> storyBlueprintId -> scriptDraftId -> editPlan -> visual anchors -> storyboard assets`.
- No first-class **visual anchors** stage that turns character/setting image
  prompts into approved `character_anchor` / `scene_anchor` reference assets.
  Character-anchor pieces exist, but the full "character and setting prompts ->
  reference images -> approved inputs for storyboard/keyframes/clips" flow is not
  implemented end to end. This stage must be conditional: not every scene, beat,
  or asset needs an anchor.
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
  durationPlan: StoryDurationPlan;
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

export interface VisualAnchorRequirement {
  id: string;
  kind: "character" | "scene" | "style" | "prop";
  requiredFor:
    | { scope: "story"; reason: string }
    | { scope: "scene"; sceneId: string; reason: string }
    | { scope: "beat"; beatId: string; reason: string };
  prompt: string;
  status: "proposed" | "approved" | "rejected" | "satisfied";
  activeAnchorAssetId?: string;
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

## Execution and stage contracts

There are two layers to keep distinct:

1. **Leaf agents** produce structured JSON. These are model calls like the
   existing `planEdit()` pattern: prompt in, JSON schema out, validated and
   persisted by the server.
2. **The orchestrator** chooses tools. In the first implementation this can be a
   fixed server sequence. Later, the orchestrator-tools lane can make it an
   agent loop where the orchestrator emits tool calls such as
   `develop_story_blueprint`, `draft_script`, `generate_anchor`, or
   `assemble_timeline`.

Do not make leaf agents directly mutate storage. They return JSON. Server-side
tool handlers validate, persist, attach run artifacts, update project pointers,
and advance the run.

### First implementation: fixed engine, structured outputs

| Stage | Caller / agent | Input loaded by server | Agent output | Server persists | Next stage receives |
| --- | --- | --- | --- | --- | --- |
| `brief_intake` | API / engine | request body or existing `briefVersionId` | none, deterministic validation | `brief_versions` row; run/stage status | `briefVersionId`, `VideoBriefInput` |
| `story_development` | Story Agent (`developStoryBlueprint`) | `BriefVersion`, duration plan, project context | `StoryBlueprint` JSON | `story_blueprints` row; `projects.current_story_blueprint_id`; stage artifact snapshot/ref | `storyBlueprintId` |
| `script_planning` | Script Agent (`draftScriptScenes`) | `BriefVersion`, `StoryBlueprint`, duration plan | `ScriptDraft` JSON | `script_drafts` row; `projects.current_script_draft_id`; stage artifact snapshot/ref | `scriptDraftId`, `storyBlueprintId` |
| `creative_plan` | Shot Planner Agent (`planShotsFromStory`) | `BriefVersion`, `StoryBlueprint`, `ScriptDraft`, duration plan | `EditPlan` JSON with scenes/beats/durations/character IDs | `projects.plan`; stage artifact snapshot/ref; optional `compositions` seed | `EditPlan`, stable scene/beat IDs |
| `visual_anchors` | Anchor Planner + anchor generation tools | `EditPlan`, story/script characters, existing asset pool | `VisualAnchorRequirement[]` JSON plus generated/selected anchor assets | `character_anchor` / `scene_anchor` assets and selections; stage items; provenance | active anchor IDs by scene/beat |
| `storyboard` | Storyboard tool/agent | `EditPlan`, applicable anchor IDs | `beat_storyboard` assets | pooled assets with `depicts.beatId` and anchor provenance; stage items | approved storyboard asset IDs by beat |
| `asset_generation` | Visual media tools | `EditPlan`, applicable anchors, approved storyboard tiles, provider policy | `beat_keyframe`, `beat_clip`, and caption/visual-support assets | pooled assets, active selections, generation jobs/items, provenance input edges | ready visual asset IDs |
| `audio_generation` | Audio/Narration Agent + audio tools | `ScriptDraft`, timeline target, existing audio policy | narration/voice/music assets or no-op decision | audio assets, measured duration, narration strategy | ready audio asset IDs |
| `timeline_assembly` | Editor Agent (`assembleTimeline`) | `EditPlan`, ready visual/audio assets, composition | `VersionedTimeline` / `EditGraph` JSON | `timelines`, `edit_graphs`, stage artifact | timeline ID |
| `quality_review` | Critic Agent | timeline, edit graph, upstream story/script/plan/asset IDs | patch decisions or regeneration proposal JSON | critic report, patch ops, optional regeneration request | revised timeline or blocked proposal |
| `export` | Render tool | approved timeline/render plan | render artifact metadata | export job/artifact row | final MP4 URL |

### Stage transition rules

- A stage advances only after its canonical output is persisted and its run stage
  is marked succeeded.
- The next stage reads by IDs from storage, not by hidden prompt context. For
  example, `script_planning` receives `storyBlueprintId`, then the server loads
  the `story_blueprints` row.
- Review gates pause after a stage succeeds and before the next expensive or
  dependent stage starts. Approval records the stage as reviewed; rejection
  creates a revision/retry request against that stage's canonical resource.
- For `targetLengthSec > 120`, the fixed engine must enforce approval before
  `asset_generation`: story blueprint, script draft, shot/beat plan, visual
  anchors, and storyboard/pre-viz.
- Every generated asset records input edges by ID: `beatId`, applicable
  `anchorIds`, `storyboardAssetId`, `firstFrameAssetId`, `audioId`, and
  upstream asset IDs when relevant.
- Tool failures should be structured and actionable. Example: if a beat uses a
  recurring main character but no active `character_anchor` exists, the media
  tool returns a precondition miss; the engine/orchestrator routes back through
  `visual_anchors` to satisfy it.

### Target implementation: orchestrator tool loop

The target orchestrator does not ask each specialist agent to call arbitrary
storage APIs. It calls server-owned tools with typed inputs and receives typed
results:

```ts
type StoryToolCall =
  | { tool: "develop_story_blueprint"; input: { briefVersionId: string } }
  | { tool: "draft_script"; input: { briefVersionId: string; storyBlueprintId: string } }
  | { tool: "plan_shots"; input: { briefVersionId: string; storyBlueprintId: string; scriptDraftId: string } }
  | { tool: "plan_visual_anchors"; input: { projectId: string; planVersionId?: string } }
  | { tool: "generate_anchor"; input: { requirementId: string; prompt: string } }
  | { tool: "generate_storyboard"; input: { beatId: string; anchorIds?: string[] } }
  | { tool: "generate_media"; input: { beatId: string; storyboardAssetId?: string; anchorIds?: string[] } }
  | { tool: "assemble_timeline"; input: { projectId: string; compositionId?: string } }
  | { tool: "critique_timeline"; input: { timelineId: string } }
  | { tool: "export_video"; input: { timelineId: string } };

type StoryToolResult =
  | { ok: true; resourceIds: string[]; artifactIds?: string[]; costUsd?: number }
  | { ok: false; error: ToolError };
```

Leaf agents remain structured-output calls behind those tools:

- `develop_story_blueprint` calls the Story Agent and persists
  `StoryBlueprint`.
- `draft_script` calls the Script Agent and persists `ScriptDraft`.
- `plan_shots` calls the Shot Planner Agent and persists `EditPlan`.
- `plan_visual_anchors` may be deterministic plus model-assisted: it proposes
  `VisualAnchorRequirement[]`, but only requirements that matter for continuity
  or provider constraints.
- `generate_anchor`, `generate_storyboard`, `generate_media`, and `export_video`
  are provider/tool calls with deterministic precondition validation.

This gives the future orchestrator latitude to re-enter any point in the flow
without losing the artifact chain.

## Stage changes

Target stage order:

```text
brief_intake
  -> story_development
  -> script_planning
  -> creative_plan
  -> visual_anchors
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
- `visual_anchors`

All three new stages should be gateable. Reviewing the story blueprint is
cheaper and more valuable than reviewing generated video after the wrong story
has already been made. Visual anchors are also worth reviewing because they can
steer many downstream storyboard, keyframe, and clip generations.

For runs where `targetLengthSec > 120`, these gates are mandatory:

- `story_development`
- `script_planning`
- `creative_plan`
- `visual_anchors`
- `storyboard`

`asset_generation` must not start until all mandatory pre-asset gates are
approved. The `visual_anchors` gate should include character and setting
reference prompts plus generated or uploaded anchor images that will materially
steer storyboard, keyframe, and clip generation. The storyboard gate should
include generated sketch panels.

Visual anchors are selective, not universal. The agent should propose anchor
requirements only when continuity or provider constraints justify them. Examples:

- A recurring main character appears in beats 1, 3, and 5 -> create or select one
  `character_anchor` and pass that anchor ID only into those beats.
- A scene depends on a distinctive setting -> create or select a `scene_anchor`
  for that scene and pass it into storyboard/keyframe generation for the scene's
  beats.
- A one-off b-roll shot with no recurring subject or important location -> no
  visual anchor is required.

Downstream media tools should receive the active anchor IDs that apply to the
specific scene/beat they are generating, and record those IDs in provenance.

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
  -> character_anchor / scene_anchor assets
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

5. **Visual anchors.**
   Add a `visual_anchors` stage that derives conditional anchor requirements
   from the story/script/plan. The stage should generate or attach
   `character_anchor` and `scene_anchor` assets only for the characters/scenes/
   beats that need them, record provenance, and let the user approve or replace
   anchors before storyboard or final media generation. Reuse the existing
   character-anchor primitive where possible; add the missing scene-anchor path.

6. **Run stages.**
   Add `story_development`, `script_planning`, and `visual_anchors` to generation
   stage types, stage order, labels, payload seeding, progress UI, and review
   gates. Enforce mandatory pre-asset gates for `targetLengthSec > 120`.

7. **Granular API endpoints.**
   Add story/script endpoints that mirror the plan endpoint's async job shape and
   typed precondition errors.

8. **Story-aware regeneration scope.**
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
- Should setting anchors be generated per scene by default, or only when the
  scene setting materially affects continuity?
- What exact plan field owns `VisualAnchorRequirement[]`: `EditPlan`, `Scene`,
  `Beat`, or a separate `visual_anchor_requirements` table/resource?

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
  script draft, shot/beat plan, visual anchors, and storyboard/pre-viz before
  `asset_generation` can start.
- Character/setting image prompts are represented by a `visual_anchors` stage and
  produce approved `character_anchor` / `scene_anchor` assets only for declared
  anchor requirements before they steer storyboard, keyframe, or clip generation.
- Beat/storyboard/keyframe/clip generation receives only the active anchor IDs
  that apply to the specific scene/beat being generated, and records those IDs in
  provenance.
- `story_blueprints` and `script_drafts` are canonical tables; generation stage
  artifacts only reference or snapshot them.

## Appendix: Landing-page flow image prompt

Use this only after the product flow is backed by the scoped implementation. The
image should not overstate current behavior before the story/script stages and
approval policy exist.

Approval gates should be shown as recurring checkpoint markers. Conceptually, a
future orchestrator can pause at any artifact, but this scope makes the
pre-asset gates mandatory for videos over 120 seconds: story blueprint, script
draft, shot/beat plan, and storyboard/pre-viz.

### Detailed prompt

```text
Create a polished 16:9 landing-page explainer image for Popcorn Ready, an AI-native video studio. Show the end-to-end workflow from a user concept to a finished video. The image should look like a premium modern SaaS product diagram: dark neutral interface, warm popcorn-yellow accents, clean arrows, subtle film-strip and timeline details, structured UI panels, and readable short labels.

Overall composition:
A left-to-right workflow made of connected product UI panels. Each panel should show a different artifact being created and passed forward. Use small approval-check icons as recurring checkpoint markers on the panels where review can happen. Make the flow feel agent-driven, inspectable, and structured.

Stage 1: Prompt / Concept
Visual: a clean prompt composer UI with a typed idea, for example "Comedy in space where explorers keep cloning themselves." Include small controls for duration, aspect ratio, audience, and style. The duration selector should show options like "30s", "2m", "5m" to imply that length changes the workflow.
Label: Prompt / Concept
Tiny description: User gives the idea, length, format, and constraints.

Stage 2: Story Blueprint
Visual: a structured document panel with sections for premise, logline, characters, story arc, acts, tone, and ending. Show it as a neat outline, not paragraphs of unreadable text. Include a small agent badge or artifact ID like "story_blueprint.v1".
Label: Story Blueprint
Tiny description: Agent develops the narrative structure.

Stage 3: Script Draft
Visual: a screenplay-like scene document with scene headings, short dialogue lines, narration blocks, and emotional/comedic beats. Show a few stacked scene cards, each with character names and dialogue lines. Include artifact ID "script_draft.v1".
Label: Script Draft
Tiny description: Scenes, dialogue, narration, and turns.

Stage 4: Shot + Beat Plan
Visual: a production planning board. Show scenes grouped into rows, each containing beat/shot cards with duration badges like "4s", "6s", "8s". Include fields like setting, mood, character IDs, and asset needs using compact chips/icons. This should feel like structured data, not a freeform storyboard yet.
Label: Shot + Beat Plan
Tiny description: Script becomes timed scenes and shots.

Stage 5: Visual Anchors / Reference Prompts
Visual: a reference-building panel with two columns: Character Anchors and Setting Anchors. Show compact image-prompt cards such as "Captain Mara: silver flight suit, anxious comic energy" and "Orbital cloning lab: cramped white station corridor, blinking warning lights." Next to each prompt, show generated reference images or approved user-uploaded references. Include small labels like "character_anchor" and "scene_anchor" to show these images steer later storyboard, keyframe, and clip generation.
Label: Visual Anchors
Tiny description: Character and setting prompts become reference images.

Stage 6: Storyboard / Pre-viz
Visual: rough pencil/marker storyboard sketch panels, one panel per beat, grouped by scene. The panels should look intentionally sketchy, with camera arrows and framing marks, not final photoreal images. Add small approval-check markers above some panels.
Label: Storyboard Sketches
Tiny description: Cheap visual preview before final generation.

Stage 7: Final Media Generation
Visual: a grid of generated asset cards: photoreal keyframes, short video clip thumbnails, voice/audio waveform, captions, and visual assets. Show arrows from visual anchors and storyboard sketches to polished keyframes, then to video clips. Make it clear these are final media assets generated after approval, and that character/setting anchors keep people and places consistent.
Label: Media Generation
Tiny description: Keyframes, clips, audio, captions, consistent characters and settings.

Stage 8: Timeline Assembly + Critic Loop
Visual: a structured video timeline UI with tracks, clips arranged in order, captions, audio waveform, and a critic/review panel showing checks like pacing, continuity, story fit, and quality. Include a curved loop arrow back to earlier artifact panels to show targeted revisions.
Label: Timeline + Critic
Tiny description: Agent assembles, reviews, and fixes the cut.

Stage 9: Deterministic Render
Visual: a finished video player showing a polished frame from the final video, with an "MP4 Ready" badge, download icon, and render metadata like "1080p" or "Remotion render". It should clearly look like the final exported video.
Label: Final Render
Tiny description: Structured timeline becomes finished MP4.

Approval gate treatment:
Show approval as small recurring checkpoint markers, not as a separate standalone stage. Use check icons, review badges, or small "Approve" chips near Story Blueprint, Script Draft, Shot + Beat Plan, Visual Anchors, and Storyboard Sketches. For longer videos, imply these are required before Media Generation. For shorter videos, imply they are optional. Do not make approval look like the entire workflow stops forever; make it feel like controlled human-in-the-loop review.

Important conceptual constraints:
- The AI does not directly edit raw video.
- The workflow passes durable structured artifacts forward: Brief, Blueprint, Script, Plan, Visual Anchors, Storyboard, Assets, Timeline, MP4.
- The user directs and approves; the agent plans, generates, assembles, critiques, and renders.
- Video length changes the depth of planning.
- Longer videos require approval before expensive asset generation, including approval of character/setting references when they steer the final video.
- Revisions can target affected artifacts instead of regenerating everything.

Visual style:
Premium, clear, modern, cinematic SaaS diagram. Dark graphite background, warm popcorn-yellow highlights, restrained white and gray text, crisp product UI panels, thin arrows, clean iconography, subtle film-strip/timeline motifs. Make labels readable. Avoid clutter.

Avoid:
No robot mascot.
No generic stock-photo people.
No chaotic sci-fi holograms.
No manual editing workstation as the main metaphor.
No tiny unreadable paragraphs.
No implying that storyboard sketches become the literal first frame of the final video.
No omitting character/setting reference prompts; they are visual anchors that guide consistency.
No implying the AI edits raw video directly.
```

### Short prompt

```text
Create a premium 16:9 SaaS explainer graphic for Popcorn Ready showing prompt-to-video workflow as connected product UI panels. Include: Prompt/Concept with duration selector; Story Blueprint document with premise, characters, arc, ending; Script Draft with scene cards and dialogue; Shot + Beat Plan with timed shot cards; Visual Anchors panel with character and setting image prompts becoming reference images; Storyboard Sketches as rough pencil panels grouped by scene; Media Generation grid with photoreal keyframes, clips, audio waveform, captions, and consistent character/setting assets; Timeline + Critic panel with tracks and targeted revision loop; Final Render video player marked MP4 Ready. Show small recurring approval-check markers near Story Blueprint, Script Draft, Shot + Beat Plan, Visual Anchors, and Storyboard, especially for videos over 2 minutes before media generation. Use dark modern UI, warm popcorn-yellow accents, artifact IDs, arrows, clean readable labels. Emphasize structured artifacts and agent handoff, not raw video editing. No robot mascot, no clutter, no manual editor metaphor.
```
