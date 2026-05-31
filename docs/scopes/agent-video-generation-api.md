# Agent Video Generation API Scope

## Objective

Expose Popcorn Ready video creation through stable `/api/v1` endpoints designed for
external agents. Agents should be able to create videos from:

- Provided video, image, and audio assets.
- Generated assets created from prompts.
- Prompt-only requests where Popcorn Ready generates the required visuals, narration,
  timeline, and export without pre-supplied media.
- Hybrid requests where agents provide some assets and ask Popcorn Ready to fill gaps.

This scope is narrower than the full [Agent API](./agent-api.md) scope: it
focuses on the staged work needed to let agents request complete video
generation workflows and inspect intermediate project state.

## Product Principles

- Agents operate on projects, assets, generated assets, timelines, jobs, and
  artifacts rather than private browser-only routes.
- Every mutating endpoint is idempotent so agents can retry after network loss.
- Long-running work returns jobs. Agents poll job state and fetch result
  resources.
- The API supports both asset-driven editing and prompt-only video creation.
- Prompt-only generation is still structured: the system creates a brief,
  generated assets, a validated timeline, and an export artifact.
- Generated outputs must be traceable to the brief, source assets, prompts,
  provider settings, preflight checks, timeline patches, and export settings.
- Local agents can run the full flow under `AUTH_MODE=local`; hosted agents use
  workspace-scoped API keys.
- Provider selection should have product defaults, but callers can override the
  provider list and specific provider settings when they know what they want.
- Audio and video alignment is a prerequisite for complete video generation.
  The API should not knowingly produce final exports with narration that drifts
  out of sync with the visual timeline.

## Core Agent Workflows

### Workflow A: Agent Supplies Source Media

The agent creates a project, registers or uploads source videos/images/audio,
adds asset context, requests a timeline, then exports.

```text
create project
  -> register assets
  -> attach project brief and clip context
  -> generation job creates timeline
  -> optional revision jobs create sibling timelines
  -> export job creates artifact
```

This is the closest match to the current MVP editor loop.

### Workflow B: Prompt-Only Video

The agent provides a goal, format, duration, style, and optional narration or
brand constraints. Popcorn Ready creates missing media assets first, then builds the
timeline and export.

```text
create project with brief
  -> composition job plans required assets
  -> asset generation jobs create images/video/audio
  -> timeline generation job selects generated assets
  -> export job creates artifact
```

Prompt-only generation should not be a black-box "make video" call internally.
It should produce inspectable assets and a timeline so the agent can review,
revise, or reuse intermediate outputs.

### Workflow C: Hybrid Agent-Assisted Generation

The agent supplies some source assets and asks Popcorn Ready to fill missing shots,
audio, or character-consistent cutaways.

```text
create project
  -> register provided assets
  -> request generated assets for missing beats
  -> generation job creates timeline from provided + generated assets
  -> optional character/reference review
  -> export
```

Hybrid is the expected production path for many agents because they can provide
logos, screenshots, product footage, character references, or brand imagery
while delegating missing visuals.

## API Surface

These routes should live under `/api/v1` and follow the shared contract from
[API Contract V1](./api-contract-v1.md).

### Project And Brief

- `POST /api/v1/projects`
- `GET /api/v1/projects/:projectId`
- `PUT /api/v1/projects/:projectId/brief`
- `POST /api/v1/projects/:projectId/brief-versions`

Brief fields required for agent video generation:

```ts
interface VideoBriefInput {
  goal: string;
  targetLengthSec: number;
  aspectRatio: "9:16" | "16:9" | "1:1";
  platform?: "youtube" | "tiktok" | "reels" | "facebook" | "vimeo" | "general";
  audience?: string;
  style?: string;
  format?:
    | "mystery_to_model"
    | "visual_reveal"
    | "challenge"
    | "misconception"
    | "animated_explainer"
    | "classroom_demo"
    | "aesthetic_montage";
  narration?: {
    mode: "none" | "generate" | "provided_text" | "provided_asset";
    script?: string;
    voiceId?: string;
    audioAssetId?: string;
  };
  constraints?: {
    mustUseAssetIds?: string[];
    avoidAssetIds?: string[];
    requiredBeats?: string[];
    forbiddenClaims?: string[];
    brandVoice?: string;
    callToAction?: string;
  };
}
```

### Asset Registration

- `POST /api/v1/projects/:projectId/assets`
- `POST /api/v1/projects/:projectId/assets/upload-url`
- `PATCH /api/v1/projects/:projectId/assets/:assetId/context`
- `GET /api/v1/projects/:projectId/assets`

Asset source modes:

```ts
type AgentAssetSource =
  | { type: "remote_url"; url: string }
  | { type: "local_path"; path: string } // local mode only
  | { type: "multipart_upload" }
  | { type: "generated"; generatedAssetId: string };
```

Agents should be able to register:

- Video clips.
- Image clips.
- Audio clips such as narration, music, or sound effects.
- Reference images for characters, products, style, or brand.

### Generated Asset Requests

- `POST /api/v1/projects/:projectId/generated-assets`
- `GET /api/v1/projects/:projectId/generated-assets/:jobId`

Request:

```json
{
  "kind": "image",
  "provider": "openai",
  "prompt": "Vertical cinematic macro of a petri dish...",
  "description": "Petri dish halo hook visual",
  "durationSec": 4,
  "referenceAssetIds": ["asset_logo"],
  "characterProfileIds": ["char_fleming"],
  "characterReferenceIds": ["ref_hero"],
  "consistencyMode": "hero_frame",
  "preflightReviewIterations": 1
}
```

Generated asset jobs should produce normal asset records, not a separate hidden
media type. Agents can then use those assets in timeline generation, revisions,
or future generated asset requests.

### Composition Planning

- `POST /api/v1/projects/:projectId/compositions`
- `GET /api/v1/projects/:projectId/compositions/:jobId`

Composition planning is the prompt-only and hybrid bridge. It turns a brief into
an explicit list of needed source assets and generation tasks before building a
timeline.

The planner should choose the mix of generated images, generated video clips,
and generated audio from the brief and target platform. Early product defaults
can bias toward lower-cost image+narration outputs, but the API should preserve
room for the model to choose more video-heavy treatments when that improves the
result.

Request:

```json
{
  "briefVersionId": "briefv_123",
  "mode": "prompt_only",
  "providerPolicy": {
    "mode": "defaults_with_overrides",
    "allowedProviders": {
      "image": ["openai"],
      "video": ["gemini"],
      "audio": ["elevenlabs"]
    },
    "providerSettings": {
      "image": { "quality": "medium" },
      "video": { "model": "veo-3.1-fast-generate-preview" },
      "audio": { "voiceId": "voice_123" }
    }
  },
  "assetPolicy": {
    "useProvidedAssets": true,
    "generateMissingAssets": true,
    "maxGeneratedImages": 10,
    "maxGeneratedVideos": 3,
    "maxGeneratedAudio": 1
  }
}
```

If `providerPolicy` is omitted, Popcorn Ready uses configured defaults. Agents can
restrict providers for cost, compliance, latency, or quality reasons. Provider
credentials should be resolved from server configuration or project/workspace
settings, not passed inline on generation requests.

Result pointers:

```json
{
  "composition": {
    "id": "comp_123",
    "briefVersionId": "briefv_123",
    "mode": "prompt_only",
    "plannedAssets": [],
    "generatedAssetJobIds": ["job_img_1", "job_vid_1", "job_aud_1"],
    "status": "ready_for_timeline"
  }
}
```

### Timeline Generation

- `POST /api/v1/projects/:projectId/generations`
- `GET /api/v1/projects/:projectId/generations/:jobId`
- `GET /api/v1/projects/:projectId/timelines/:timelineId`

Generation request:

```json
{
  "briefVersionId": "briefv_123",
  "assetIds": ["asset_1", "asset_2", "asset_3"],
  "compositionId": "comp_123",
  "targetLengthSec": 60,
  "variantCount": 1,
  "audioAlignment": {
    "mode": "fit_timeline",
    "audioAssetId": "asset_narration"
  }
}
```

`assetIds` may be empty only when `compositionId` points to a completed
prompt-only composition with generated assets.

### Revision And Export

- `POST /api/v1/projects/:projectId/timelines/:timelineId/revisions`
- `GET /api/v1/projects/:projectId/timelines/:timelineId/revisions/:jobId`
- `POST /api/v1/projects/:projectId/timelines/:timelineId/exports`
- `GET /api/v1/projects/:projectId/exports/:jobId`
- `GET /api/v1/projects/:projectId/artifacts/:artifactId`

Export request:

```json
{
  "format": "mp4",
  "quality": "standard",
  "audioAssetIds": ["asset_narration"],
  "durationPolicy": "match_longest_media"
}
```

`durationPolicy` values:

- `timeline_only`: render exactly the timeline duration.
- `match_longest_media`: extend export duration to avoid cutting selected audio.
- `fail_on_mismatch`: fail validation if audio/video durations differ beyond a
  threshold.

The API should default to `fail_on_mismatch` for generated narration once an
alignment step exists. Until then, `match_longest_media` is safer than silently
truncating audio.

## Data Model Additions

### Generated Asset Provenance

```ts
interface GeneratedAssetProvenance {
  provider: string;
  model?: string;
  prompt: string;
  providerPrompt?: string;
  preflight?: GenerationPreflightResult;
  referenceAssetIds?: string[];
  characterBinding?: GeneratedAssetCharacterBinding;
  requestedDurationSec?: number;
  actualDurationSec?: number;
}
```

### Composition

```ts
interface CompositionPlan {
  id: string;
  projectId: string;
  briefVersionId: string;
  mode: "asset_driven" | "prompt_only" | "hybrid";
  plannedBeats: {
    name: string;
    intent: string;
    durationSec: number;
    assetStrategy: "use_existing" | "generate_image" | "generate_video";
    requiredAssetIds?: string[];
    generatedAssetJobIds?: string[];
  }[];
  narrationStrategy?: {
    mode: "none" | "provided" | "generate";
    script?: string;
    audioAssetId?: string;
    estimatedDurationSec?: number;
    actualDurationSec?: number;
  };
}
```

### Timeline Generation Inputs

Every generated timeline should store:

- Brief version ID.
- Composition ID, if used.
- Source asset IDs.
- Generated asset job IDs.
- Agent client ID.
- Model call IDs or provider request metadata where available.
- Critic report and applied patches.
- Audio alignment decision and measured audio duration.

## Jobs

Minimum job types:

- `asset_ingest`: register/copy/upload and inspect source media.
- `asset_generation`: generate image, video, or audio assets.
- `composition`: plan required assets for prompt-only or hybrid requests.
- `timeline_generation`: run plan/select/critique against ready assets.
- `audio_alignment`: validate or adjust narration duration against timeline.
- `revision`: produce a sibling timeline from natural-language edits.
- `export`: render a timeline to an artifact.

Job progress should use concrete step names so agents can expose useful status:

- `validating_request`
- `creating_brief_version`
- `planning_assets`
- `preflight_review`
- `generating_assets`
- `waiting_for_assets`
- `planning_timeline`
- `selecting_clips`
- `critiquing_timeline`
- `aligning_audio`
- `rendering_export`
- `saving_artifact`

## Audio Alignment Requirements

The current MVP can generate narration and overlay it, but agent workflows need
explicit alignment rules so scripts do not overrun or end early.

V1 should support:

- Persisting actual generated audio duration.
- Generating or rewriting narration after the visual timeline exists when the
  agent asks for a fixed-length video.
- Comparing audio duration to timeline duration before export.
- Returning typed validation errors when mismatch exceeds a threshold.
- Allowing agents to choose whether to shorten narration, extend timeline, or
  render to the longer media duration for drafts.

For final generation, alignment should be required. A request like "make a
one-minute video" should first create or validate the visual timeline, then
generate narration that fits that time span and corresponds to the specific
beats in the video. Audio should be segmented or time-coded enough that the
narration can be mapped back to timeline roles such as hook, explanation,
payoff, and CTA.

Suggested request:

```json
{
  "mode": "fit_timeline",
  "audioAssetId": "asset_narration",
  "timelineId": "tl_123",
  "maxDeltaSec": 1.0,
  "strategy": "rewrite_script"
}
```

Strategies:

- `rewrite_script`: shorten or expand narration text, regenerate audio, and
  keep timeline unchanged.
- `extend_timeline`: ask the revision agent to add time to existing strong
  visual beats.
- `render_longest`: export to the longer duration; useful as a fallback, not a
  polished final default.
- `fail`: return a typed error for the agent to handle.

Recommended defaults:

- For final exports, use `rewrite_script` first when narration is generated by
  Popcorn Ready.
- Use `extend_timeline` when the user explicitly prioritizes the supplied
  narration or script over the target duration.
- Reserve `render_longest` for previews, diagnostics, or explicit agent
  requests.

## PR Plan

### PR1: Versioned Agent Project And Asset Foundation

- Add `/api/v1/projects`, `/brief`, `/brief-versions`, and `/assets` route
  skeletons.
- Add shared request/response schemas and typed error envelopes.
- Add local-mode actor/workspace resolution.
- Add idempotency handling for project and asset creation.
- Support `remote_url` and local-mode `local_path` asset registration.
- Persist source asset metadata with project IDs and schema versions.

Acceptance:

- A local agent can create a project, set a brief, register an image/video/audio
  asset, and read the project state through `/api/v1`.

### PR2: Generated Asset Endpoint For Agents

- Add `POST /api/v1/projects/:projectId/generated-assets`.
- Convert generated outputs into normal project assets with provenance.
- Support image, video, and audio generation modes.
- Run preflight review where requested.
- Persist actual generated audio duration and provider settings.
- Add typed errors for unsupported provider/kind/mode combinations.

Acceptance:

- An agent can create a generated image, generated video, and generated
  narration asset, then list those assets through the standard asset API.

### PR3: Composition Planning For Prompt-Only And Hybrid Requests

- Add `POST /api/v1/projects/:projectId/compositions`.
- Plan beat-level asset needs from the brief.
- Support modes: `asset_driven`, `prompt_only`, and `hybrid`.
- Create child `asset_generation` jobs for missing images, videos, and audio.
- Persist composition plans and result pointers.

Acceptance:

- A prompt-only request produces a composition plan and generated asset jobs.
- A hybrid request respects provided assets and only generates missing beats.

### PR4: Timeline Generation From Agent Inputs

- Add `/api/v1/projects/:projectId/generations` implementation using brief
  version, composition, and ready asset IDs.
- Require assets to be ready before selection.
- Store timeline provenance and critic report.
- Return a job result with created timeline IDs.
- Add integration tests for asset-driven and prompt-only generation paths.

Acceptance:

- An agent can generate a valid timeline from supplied assets.
- An agent can generate a valid timeline from a completed prompt-only
  composition.

### PR5: Audio Alignment And Export Policy

- Add an `audio_alignment` validation step before export.
- Persist measured audio duration for generated and uploaded audio assets.
- Add export `durationPolicy`.
- Fail final exports when selected audio and timeline durations mismatch beyond
  a configured threshold.
- Add `rewrite_script` alignment for generated narration.
- Add `extend_timeline` alignment when a supplied script or audio asset is the
  source of truth.

Acceptance:

- Exports do not silently truncate narration.
- Final exports require aligned narration and visual duration.
- Agents receive explicit mismatch diagnostics and can choose an alignment
  strategy for drafts or retries.

### PR6: Revision, Artifacts, And End-To-End Agent Smoke Test

- Add natural-language revision jobs that create sibling timelines.
- Add explicit export jobs and artifact read endpoints.
- Add an end-to-end local agent smoke test:
  - prompt-only project to MP4
  - asset-driven project to MP4
  - hybrid project to MP4
- Add API examples under `docs/examples/agent-video-generation/`.

Acceptance:

- A local agent can create a video from no source media, from supplied media,
  and from mixed supplied/generated media without browser interaction.

## Testing Scope

- Contract tests for request validation, typed errors, and idempotency.
- Repository tests for project, asset, generated asset, composition, timeline,
  job, and artifact persistence.
- Job tests with mock providers for prompt-only, asset-driven, and hybrid flows.
- Export tests using tiny fixture assets.
- Audio alignment tests for short, matching, and too-long narration.
- Local smoke script that exercises the API exactly as an external agent would.

## Security And Limits

- Hosted agent clients require workspace-scoped API keys.
- API keys need explicit scopes:
  - `projects:write`
  - `assets:write`
  - `generated_assets:write`
  - `timelines:write`
  - `exports:write`
- `local_path` is allowed only under `AUTH_MODE=local`.
- Remote URL ingest must enforce size limits, content-type checks, allow/deny
  lists where needed, and download timeouts.
- Provider credentials remain server-side only.
- Local/open-source installations can configure provider API keys through
  environment variables or local settings. Hosted key-management UX is deferred
  until hosted work resumes.
- Prompt, provider, and media logs should be redacted by default.
- Hosted quota enforcement is deferred. The first iteration targets an
  open-source repo that users download and run with their own provider keys.

## Non-Goals For V1

- Webhook callbacks for job completion.
- Public SDK generation.
- OAuth-style third-party authorization.
- Frame-accurate manual editing APIs.
- Custom model training for character consistency.
- Multi-agent collaborative project locking.
- Hosted quota administration.
- Hosted provider-key management UI.

## Decisions

- Prompt-only generation should let the model choose the visual mix from the
  brief. Product defaults can evolve as we learn whether image-heavy,
  video-heavy, or mixed outputs perform better.
- Provider selection has defaults, and agents may override allowed providers and
  provider settings.
- Provider API keys are required for live generation and are configured by the
  local installation in the first iteration.
- Audio alignment is required for final generated videos. The preferred flow is
  to create or validate the visual timeline first, then generate or rewrite
  narration to fit that duration and those beats.
- Hosted quotas are out of scope for the first iteration.
- Detailed provenance exposure is deferred. Persist provenance internally and
  expose enough for debugging, then make it more flexible over time.

## Remaining Open Questions

- What is the exact threshold for audio/timeline mismatch before alignment is
  required: 0.5s, 1.0s, or a percentage of total duration?
- Should narration be generated as one audio asset with time-coded beat metadata,
  or as multiple per-beat audio assets stitched during export?
- What local settings format should be used for non-environment provider API key
  configuration?

## Acceptance Criteria

- Agents can create projects and briefs through `/api/v1`.
- Agents can register provided image, video, and audio assets.
- Agents can request generated image, video, and audio assets.
- Agents can create a prompt-only composition with no supplied assets.
- Agents can generate a validated timeline from provided, generated, or mixed
  assets.
- Agents can detect and resolve audio/timeline duration mismatch before export.
- Agents can request an MP4 export and fetch the resulting artifact.
- All workflows are idempotent, job-backed, and testable in local mode.
