# Uploaded Media Agent Editing Scope

## Objective

Let a user upload any amount of source media and have Popcorn Ready assemble it
into a finished video using the same planning, clip selection, timeline,
critique, revision, and export infrastructure used by existing generation
flows.

This feature is not a separate mode from generation. It is a continuum of
user-provided asset coverage:

- Complete coverage: the user provides every asset for the final movie,
  including video, stills, dialogue, natural audio, music, narration, titles, or
  reference material.
- Partial coverage: the user provides a handful of clips that need to be
  stitched together, with generated assets filling only the gaps.
- Reference-only coverage: the user provides assets such as character likeness
  images, style references, logos, or location images that guide generated
  shots.
- Prompt-only coverage: the user provides no media assets and the existing
  one-shot flow generates everything.

The difference from prompt-only generation is asset acquisition:

- Prompt-only: the system generates missing image/video/audio assets.
- Uploaded-media editing: the system uses user-provided source media as part or
  all of the asset pool.
- Hybrid remains supported: generated assets can still fill missing shots,
  titles, narration, music, or connective material when the brief asks for it.

## Product Principle

All media assets must become understandable source assets before the editor
agent tries to cut them or before the generation agent decides what to create.
The system should not choose clips from filenames alone, treat generated assets
as self-explanatory, or assume an audio file is usable without knowing whether
it is classical music, rap, dialogue, room tone, or something else. Each asset
needs a structured knowledge record built from both user annotations and
agent-derived observations.

This is broader than uploads. Uploaded assets, generated assets, reference
images, music, narration, effects, title graphics, logos, and future asset types
should all carry the same core concept: how much the system knows about the
asset and what the asset can be trusted to represent.

Before the normal creative flow starts, an asset-intake agent should inspect the
current asset pool and determine:

- What assets exist.
- What each asset appears to contain.
- What each asset can likely be used for.
- What the system does not know yet.
- Which missing context can be inferred by sampling/analyzing media.
- Which missing context should be requested from the user.
- Which missing assets may still need to be generated.

The output of that inventory should feed a second learning pass that fills gaps
through user-provided context, frame/snippet analysis, audio transcription, or
follow-up questions.

## Core User Workflow

1. User creates a project and uploads any mix of videos, images, audio, logos,
   likeness references, or other project assets.
2. Upload processing validates files and extracts basic media metadata.
3. Asset-intake pass inventories the current asset pool and produces knowns,
   unknowns, likely uses, and recommended analysis actions.
4. User optionally adds plain-language context for the whole project, an upload
   batch, or individual assets.
5. Asset-learning pass fills context gaps by sampling video, analyzing images,
   transcribing audio when useful, and merging user notes.
6. The user gives a creative brief: target length, style, platform, audience,
   required moments, pacing, and optional narration/music direction.
7. A planning pass creates a beat map based on the known asset pool and the
   brief.
8. A pre-generation/pre-edit critique reviews the beat map, asset coverage, and
   unknowns before any new images, videos, or audio are generated.
9. If needed and allowed, generated assets fill uncovered beats or use uploaded
   references such as character likeness images.
10. The timeline agent selects source clips, trims them, orders them, and adds
    captions or audio strategy.
11. A timeline critique pass patches the cut.
12. Export renders the finished video.

## Existing Infrastructure To Reuse

This feature should reuse:

- `/api/v1/projects` and brief versions.
- `/api/v1/projects/:projectId/assets` for uploaded source assets.
- Existing `asset_driven` composition mode.
- Existing `selectClips()` timeline agent path.
- Existing `critique()` timeline patch path.
- Existing generation-run progress stages, with labels adjusted where needed.
- Existing timeline/export infrastructure.
- Existing asset pool direction from the north-star store consolidation docs.

The main new work is asset understanding and context preparation before
timeline generation or asset generation.

## Asset Inventory And Knowledge Gap Pass

The first agent pass should not try to make the movie. It should create an
asset inventory that explains what is known and unknown about the current
project assets.

## Asset Knowledge Data Model

Every asset should have an `AssetKnowledge` record, whether the asset came from
upload, generation, import, or a future integration. This record is the durable
metadata the agents use when planning, generating, selecting, editing, and
critiquing.

Suggested shape:

```ts
interface AssetKnowledge {
  assetId: string;
  mediaType: "video" | "image" | "audio" | "text" | "reference";
  origin: "uploaded" | "generated" | "imported" | "derived";
  userContext?: UserAssetContext;
  agentContext?: AgentAssetContext;
  knowledgeScore: number; // 0..1, model-assessed
  knowledgeSummary: string;
  knownFacts: KnownFact[];
  unknowns: KnowledgeGap[];
  likelyUses: AssetUse[];
  constraints: AssetConstraint[];
  relationships: AssetRelationship[];
  provenance: AssetKnowledgeProvenance;
}

interface UserAssetContext {
  title?: string;
  description?: string;
  people?: string[];
  characterNames?: string[];
  location?: string;
  event?: string;
  notableMoments?: string[];
  tags?: string[];
  transcriptHint?: string;
  audioNotes?: string;
  intendedUse?: AssetUse[];
  mustUse?: boolean;
  avoid?: boolean;
}

interface KnownFact {
  field: string;
  value: string;
  confidence: "low" | "medium" | "high";
  source: "user" | "agent" | "generation_prompt" | "metadata" | "transcript";
}

interface AssetConstraint {
  type:
    | "must_use"
    | "avoid"
    | "likeness_reference"
    | "style_reference"
    | "brand_required"
    | "audio_required"
    | "no_audio"
    | "do_not_crop"
    | "do_not_modify";
  reason?: string;
}

interface AssetRelationship {
  type:
    | "derived_from"
    | "sampled_from"
    | "represents_character"
    | "represents_location"
    | "belongs_to_scene"
    | "audio_for"
    | "visual_for";
  targetAssetId: string;
  description?: string;
}

interface AssetKnowledgeProvenance {
  createdAt: string;
  updatedAt: string;
  analysisVersion: string;
  model?: {
    provider: string;
    model?: string;
  };
  sourcePrompt?: string;
  sampledAssetIds: string[];
  transcriptAssetId?: string;
}
```

The `knowledgeScore` should be model-assessed rather than deterministic. A user
can upload an asset with no context, and the initial score should be `0` because
the system genuinely knows nothing beyond file metadata. After image analysis,
video sampling, transcription, or generation-prompt capture, the model can
raise the score based on how confidently it understands the asset. For example:

- `0.0`: uploaded file with no user context and no analysis yet.
- `0.2`: basic media metadata only, such as duration and dimensions.
- `0.5`: sampled frames or transcript reveal broad content, but key details are
  still unknown.
- `0.8`: the asset has a clear summary, likely uses, subjects, setting, and
  constraints.
- `1.0`: reserved for assets where the system has complete enough context for
  the current task, not absolute truth about the media.

Generated assets should not skip this model. A generated clip may start with a
higher score because the generation prompt, intended scene, character refs, and
provider output metadata are known. It may still need review if the actual
generated output may not match the prompt.

Suggested shape:

```ts
interface AssetInventoryReport {
  projectId: string;
  assets: AssetKnowledgeSummary[];
  globalKnowns: string[];
  globalUnknowns: KnowledgeGap[];
  recommendedLearningActions: LearningAction[];
  coverageEstimate: {
    video: "none" | "partial" | "complete";
    images: "none" | "partial" | "complete";
    audio: "none" | "partial" | "complete";
    characters: "none" | "partial" | "complete";
    brandsOrLogos: "none" | "partial" | "complete";
  };
}

interface AssetKnowledgeSummary {
  assetId: string;
  mediaType: "video" | "image" | "audio" | "text" | "reference";
  known: string[];
  unknown: KnowledgeGap[];
  likelyUses: AssetUse[];
  confidence: "low" | "medium" | "high";
}

interface KnowledgeGap {
  field: string;
  question: string;
  canInferAutomatically: boolean;
  suggestedAction: "ask_user" | "sample_video" | "analyze_image" | "transcribe_audio";
}

interface LearningAction {
  assetId?: string;
  action: "ask_user" | "sample_video" | "analyze_image" | "transcribe_audio";
  reason: string;
}

type AssetUse =
  | "primary_footage"
  | "b_roll"
  | "character_reference"
  | "style_reference"
  | "location_reference"
  | "logo_or_brand"
  | "music"
  | "voiceover"
  | "dialogue"
  | "sound_effect"
  | "title_or_graphic";
```

This report becomes the bridge between uploaded media and the existing flow.
The next agent call should use it to decide what to learn before planning. For
example, a video with no description might trigger frame sampling, while a
character likeness image might trigger image analysis and then become a
reference for later generated video calls.

## Two Context Sources

### 1. User-Provided Context

The UI should let users annotate at three levels:

- Project-level: overall event/story/product context.
- Batch-level: shared context for clips uploaded together.
- Clip-level: what this specific video contains.

Suggested user context fields:

```ts
interface UserClipContext {
  title?: string;
  description?: string;
  people?: string[];
  location?: string;
  event?: string;
  notableMoments?: string[];
  mustUse?: boolean;
  avoid?: boolean;
  tags?: string[];
  transcriptHint?: string;
  audioNotes?: string;
}
```

The user should be able to paste rough notes without filling every field. The
agent can normalize those notes into structured context during ingest.

### 2. Agent-Derived Context

The system should inspect each source asset enough to create a useful editing
catalog. V1 should avoid full video understanding as a monolithic model call.
Instead, it should sample representative moments and analyze other media types
with the cheapest useful strategy.

Suggested analysis steps:

1. Extract media metadata: duration, dimensions, fps, codec, audio presence.
2. For video, extract evenly spaced representative frames:
   - V1 default: 5 samples per video.
   - Longer videos may use up to 10 samples.
   - Example: a 5-minute video with 5 samples produces one sample roughly each
     minute.
   - Samples do not need to be all-inclusive; they are a structured first pass
     to understand content and identify likely useful moments.
   - Scene-change detection can later replace or supplement evenly spaced
     samples.
3. For image/reference assets, send the image and user context to the vision
   model directly.
4. For audio assets or videos with important spoken content, optionally
   transcribe audio.
5. Optionally extract short snippets or low-cost frame sequences for important
   clips after the first sampling pass identifies candidates.
6. Store structured observations on the asset.

Initial storage should be local filesystem storage. Database-backed storage,
retention policy, signed URLs, and remote object storage should be decided in a
later persistence phase.

Suggested derived context:

```ts
interface AgentClipContext {
  summary: string;
  visualSubjects: string[];
  actions: string[];
  setting?: string;
  mood?: string;
  shotTypes: string[];
  usableMoments: UsableMoment[];
  cautions: string[];
  transcriptSummary?: string;
  confidence: "low" | "medium" | "high";
  sampledFrames: string[];
  model: {
    provider: string;
    model?: string;
  };
}

interface UsableMoment {
  startSec: number;
  endSec: number;
  label: string;
  description: string;
  suggestedUse:
    | "hook"
    | "context"
    | "proof"
    | "emotion"
    | "transition"
    | "detail"
    | "b_roll"
    | "cta";
}
```

The same idea should generalize beyond video:

```ts
interface AgentAssetContext {
  summary: string;
  mediaType: "video" | "image" | "audio" | "text" | "reference";
  subjects: string[];
  actions?: string[];
  setting?: string;
  mood?: string;
  likelyUses: AssetUse[];
  cautions: string[];
  transcriptSummary?: string;
  confidence: "low" | "medium" | "high";
  sampledAssetIds: string[];
  model: {
    provider: string;
    model?: string;
  };
}
```

## Combined Clip Context

The edit agent should receive a merged context object, not separate raw user and
model notes.

```ts
interface ClipUnderstanding {
  assetId: string;
  source: "upload" | "generated";
  userContext?: UserClipContext;
  agentContext?: AgentClipContext | AgentAssetContext;
  combinedSummary: string;
  timelineHints: {
    mustUse: boolean;
    avoid: boolean;
    preferredBeats: string[];
    bestStartSec?: number;
    bestEndSec?: number;
  };
  provenance: {
    userContextUpdatedAt?: string;
    analyzedAt?: string;
    analysisVersion: string;
    sampledFrameAssetIds: string[];
  };
}
```

The `combinedSummary` is what gets projected into the existing `Clip.description`
or future asset-pool description used by `clipCatalog()` and `selectClips()`.

## Editing Flow

### Asset-Driven Run

```text
upload assets
  -> inventory asset knowns/unknowns
  -> learn missing asset context
  -> merge user + agent context
  -> create/update brief version
  -> plan edit beats
  -> critique plan against available source coverage
  -> select clips and trims
  -> critique timeline
  -> export
```

### Hybrid Run

```text
upload assets
  -> inventory asset knowns/unknowns
  -> learn missing asset context
  -> plan edit beats
  -> identify missing beats or weak coverage
  -> optionally generate missing assets
  -> select uploaded + generated clips
  -> critique timeline
  -> export
```

## Plan Critique For Uploaded Footage

The pre-edit critique added for one-shot generation should be extended so it can
review source coverage before the timeline is built.

Inputs:

- user creative brief
- planned beats
- source clip catalog with merged clip context
- must-use/avoid constraints
- target length, platform, and style

Outputs:

- revised beat plan
- coverage assessment for each beat
- list of clips likely to serve each beat
- missing-coverage warnings
- recommendation: proceed with uploaded-only edit, ask user for more footage, or
  generate missing assets

Suggested report shape:

```ts
interface UploadedFootagePlanReview {
  storyArc: "pass" | "needs_review" | "fail";
  sourceCoverage: "pass" | "needs_review" | "fail";
  timing: "pass" | "needs_review" | "fail";
  missingBeats: string[];
  recommendedMode: "uploaded_only" | "hybrid_generate_gaps" | "needs_more_source";
  revisedPlan: EditPlan;
}
```

## Timeline Selection Requirements

The timeline agent should be able to:

- Select from uploaded videos by asset ID.
- Trim using source in/out times.
- Use multiple segments from the same source video when useful.
- Respect must-use and avoid constraints.
- Prefer clips whose context matches beat intent.
- Avoid repetitive shots unless requested.
- Use natural audio only when appropriate.
- Leave room for narration/music when requested.
- Produce captions only when the brief or platform calls for them.

Current `selectClips()` already has the right shape, but its clip catalog needs
richer descriptions and useful-moment ranges so it is not guessing from broad
clip summaries.

## API Scope

### Asset Context

Add or extend:

- `POST /api/v1/projects/:projectId/assets/inventory`
- `PATCH /api/v1/projects/:projectId/assets/:assetId/context`
- `POST /api/v1/projects/:projectId/assets/:assetId/analyze`
- `POST /api/v1/projects/:projectId/assets/analyze-batch`

`inventory` should return the asset knowledge report synchronously when
possible. It should be cheap: use uploaded file metadata, existing context, and
already available derived records. It should not trigger expensive model calls
unless explicitly requested.

`analyze-batch` should return a job because multi-video analysis can be slow.

Inventory request:

```json
{
  "assetIds": ["asset_1", "asset_2", "asset_3"],
  "includeExistingContext": true
}
```

Inventory response:

```json
{
  "report": {
    "projectId": "project_123",
    "globalUnknowns": [
      {
        "field": "asset_1.subjects",
        "question": "Who appears in this clip?",
        "canInferAutomatically": true,
        "suggestedAction": "sample_video"
      }
    ],
    "recommendedLearningActions": [
      {
        "assetId": "asset_1",
        "action": "sample_video",
        "reason": "Video has no visual summary."
      }
    ]
  }
}
```

Request:

```json
{
  "assetIds": ["asset_1", "asset_2"],
  "userContext": {
    "event": "Founder keynote at customer summit",
    "goal": "Find moments that show customer excitement"
  },
  "analysisOptions": {
    "sampleFrames": true,
    "transcribeAudio": false,
    "defaultVideoSamples": 5,
    "maxVideoSamples": 10,
    "storage": "local"
  }
}
```

Response:

```json
{
  "job": {
    "id": "job_asset_analysis_123",
    "type": "asset_analysis",
    "status": "queued"
  }
}
```

### Uploaded-Footage Generation

Existing generation endpoints should accept uploaded assets through `assetIds`
or `compositionId`.

For a direct asset-driven edit:

```json
{
  "briefVersionId": "briefv_123",
  "assetIds": ["asset_1", "asset_2", "asset_3"],
  "variantCount": 1,
  "mode": "asset_driven",
  "allowGeneratedGapFill": false
}
```

For hybrid gap fill:

```json
{
  "briefVersionId": "briefv_123",
  "assetIds": ["asset_1", "asset_2", "asset_3"],
  "mode": "hybrid",
  "allowGeneratedGapFill": true,
  "providerPolicy": {
    "allowedProviders": {
      "image": ["openai"],
      "video": ["gemini"],
      "audio": ["elevenlabs"]
    }
  }
}
```

## UI Scope

### Upload And Context Step

The UI should support:

- Drag-and-drop multi-upload.
- Per-file processing status.
- Asset inventory status showing what the system knows and does not know.
- Bulk context box for all uploaded clips.
- Per-clip context fields.
- Per-image, per-audio, and per-reference context fields where relevant.
- “Analyze clips” action.
- Reviewable analysis summaries and sampled frames.
- Editable tags and must-use/avoid toggles.
- Optional prompts for missing context that the inventory pass cannot infer
  automatically.

### Brief Step

Prompt composer should support “Edit my uploaded footage” mode:

- User describes the desired final video.
- User chooses uploaded-only or allow AI gap fill.
- User selects target length/aspect/platform/style.
- UI shows whether clips have enough context to proceed.

### Progress Step

Suggested stages:

| Stage | Purpose |
| --- | --- |
| `brief_intake` | Collect brief and uploaded-asset choices. |
| `asset_inventory` | Determine knowns, unknowns, likely uses, and needed learning actions. |
| `asset_analysis` | Extract frames, transcribe if requested, summarize uploaded media. |
| `creative_plan` | Plan the story arc and beat map. |
| `plan_review` | Check source coverage before editing. |
| `timeline_assembly` | Select clips, trims, captions, and audio strategy. |
| `quality_review` | Critique and patch the cut. |
| `export` | Render final output. |

## Implementation Phases

### PR1: Asset Context Contract And Inventory

- Add `UserClipContext`, `AgentClipContext`, `AgentAssetContext`,
  `ClipUnderstanding`, and `AssetInventoryReport` types.
- Extend asset records with user and agent context.
- Add context update API.
- Add cheap asset inventory API that reports knowns, unknowns, likely uses, and
  recommended learning actions.
- Project context into `Clip.description` or the future asset pool catalog.
- Tests for context parsing, inventory output, and local storage paths.

### PR2: Video Analysis Job

- Add frame extraction utility using `ffmpeg`.
- Add batch asset analysis job.
- Use 5 evenly spaced video samples by default, with up to 10 for longer videos
  or user-requested deeper analysis.
- Use OpenAI vision by default for sampled-frame summaries.
- Store sampled frame paths and structured observations.
- Degrade cleanly if `ffmpeg` is missing.

### PR3: Uploaded-Footage Edit Flow

- Add UI mode for uploaded footage.
- Ensure the generation request passes selected uploaded asset IDs.
- Extend plan critique to include source coverage.
- Reuse `selectClips()` to build the timeline from uploaded assets.
- Persist output timeline and project state.

### PR4: Hybrid Gap Fill

- Detect beats with weak uploaded-source coverage.
- Ask user whether to generate missing assets or proceed with uploaded-only.
- Reuse generated asset jobs for missing beat visuals/audio.
- Build final timeline from uploaded and generated assets.

### PR5: Review And Controls

- Show analysis summaries, sampled frames, and model confidence.
- Let users correct clip context before editing.
- Add “regenerate analysis” and “ignore this clip” actions.
- Add review gates before timeline assembly when context confidence is low.

## Acceptance Criteria

- A user can upload at least 10 source videos and request a finished edit.
- The agent can build a timeline entirely from uploaded clips.
- The agent can use user-provided context when available.
- The agent can create clip context from sampled frames when user context is
  sparse.
- The timeline agent sees structured clip descriptions and usable moments, not
  just filenames.
- The plan review can warn when source footage does not cover the requested
  story.
- The final output is an inspectable timeline with source clip IDs and trim
  ranges.
- The flow works without generated assets, while preserving a clear path to
  hybrid generation.

## Open Questions

- Should uploaded-video analysis run automatically after upload, or only after
  the user clicks “Analyze clips”?
- Should transcription be on by default for videos with speech, given cost and
  latency?
- Should “must use” apply to the whole clip or to specific detected moments?
- Should generated gap fill be automatic when coverage is weak, or always gated
  by user approval?
- Should image/reference assets be grouped by role automatically, or should the
  user label assets as character, logo, style, location, or prop references?
- When the inventory pass finds unknowns, should the UI interrupt the flow with
  questions or allow the user to proceed with lower confidence?
