# AI-Native Edit Graph Scope

## Objective

Move the canonical edit representation from a timeline-as-source-of-truth model
to a layered **semantic edit graph**, and treat the timeline as a *compiled
artifact* derived from that graph rather than the thing the AI authors directly.

Today the product "revolves around the Timeline" (`src/lib/types.ts:1`). The
timeline is what the planner produces, what revisions patch, and what the
renderer consumes. That is the human-NLE mental model — tracks, segments, source
in/out, captions — with an AI bolted on top. This scope proposes the inverse:
the AI reasons over creative intent, semantic media, a story plan, and explicit
edit decisions; the timeline is the last compilation step before render.

This builds on [Project Model And Storage](./project-model-storage.md),
[API Contract V1](./api-contract-v1.md),
[Agent Video Generation API](./agent-video-generation-api.md), and the
revision/critic loop in [OODA Feedback Loop](./ooda-feedback-loop.md). It does
not throw away the current types — most of them become *layers* in the graph.

## Why The Timeline Should Not Be The Source Of Truth

A human editor thinks "put this clip here, trim that, fade out." So the NLE data
model optimizes for tracks, clips, timecodes, transitions, keyframes.

An AI editor thinks "make a 45-second product demo that opens with a hook, shows
the pain, demonstrates the feature, adds proof, ends with a CTA." It needs
first-class objects for hook, beat, claim, evidence, emotion, pacing, semantic
relevance, and — critically — the *reason* a cut happens. A raw timeline cannot
express those well, so when the user says "make it punchier" or "make the story
clearer," an edit that only stores `{ cutAtMs: 18620 }` has nothing to reason
over. It can shorten clips at random; it cannot target weak beats, dead air,
redundant transcript spans, or unsupported claims.

The fix is to preserve intent and rationale as structured data, and to compile
the timeline from it.

## We Are Already Halfway There

The current model already embeds semantic signal inside the timeline — it just
isn't promoted to its own layer:

| Current type (`src/lib/types.ts`) | Semantic role it is already playing |
| --- | --- |
| `Clip` (with `description`, `generatedBy`) | Source media asset + provenance |
| `Beat`, `EditPlan` | A thin story plan (role, intent, duration) |
| `StoryContext` | Creative brief / narrative framing |
| `TimelineSegment.role` + `.reason` | An **edit decision** flattened into the timeline |
| `Patch` (replace/trim/reorder/add/caption) | Imperative edit decisions applied to the timeline |
| `CriticReport`, `CriticScores` | Post-hoc analysis / quality scoring |
| `GenerationPreflightResult` | Pre-generation reasoning trace |
| `CompositionPlan`, `CompositionPlannedBeat` | A partial story plan + asset selection strategy |

The migration is mostly **lifting these out of the timeline into named layers**
and adding the connective tissue (segment-level analysis, transcript, ranked cut
candidates) that does not exist yet.

## Target Architecture: A Compiler Pipeline

Treat AI video editing like compiling code. The source language is creative
intent; the executable output is a rendered video; the timeline is the
intermediate representation just before codegen.

```text
Creative Brief        (what the video should accomplish)
   ↓ planner
Story Plan            (beats, emotional arc, pacing)
   ↓ selector         (uses Semantic Analysis of media)
Segment Assignments   (which media satisfies which beat)
   ↓ editor
Edit Decision Graph   (cuts, transitions, overlays, captions + rationale)
   ↓ compiler
Timeline              (tracks, items, timecodes — derived)
   ↓ renderer
MP4
```

Every stage is inspectable, which is what makes revision intelligent: a request
maps to the right layer instead of blindly mutating timecodes.

The canonical project becomes a multi-resolution graph, of which the timeline is
one projection:

```text
Project
├── assets            (immutable source media)
├── analysis          (transcript, segments, audio/visual events, quality, embeddings)
├── intent            (CreativeBrief)
├── story             (StoryPlan: beats, emotional arc, pacing)
├── edit              (decisions, transitions, overlays, constraints)
├── timeline          (compiled tracks + items)
└── render            (RenderPlan)
```

Other projections the same graph can yield without being the source of truth:
transcript view, story-beat view, shot list, scene graph, audio-mix view, and
platform-specific cutdowns.

## Proposed Layers

Types below are illustrative and adapted to repo conventions. **Unit note:** the
current code uses seconds (`durationSec`, `sourceInSec`). Sub-second cut
precision (e.g. a 220ms pause) wants milliseconds. New graph layers use
`...Ms`; the compiler converts to the timeline's existing second-based fields
until we migrate units wholesale. See Open Decisions.

### Layer 1 — Source Media (immutable)

The raw material. The AI never edits these directly. This is essentially today's
`Clip` plus structured metadata; aligns with `Asset` in
[Project Model And Storage](./project-model-storage.md).

```ts
type MediaAsset = {
  id: string;
  uri: string;
  type: "video" | "audio" | "image" | "text" | "generated";
  durationMs?: number;
  metadata: {
    width?: number; height?: number; fps?: number;
    sampleRate?: number; channels?: number; codec?: string;
  };
  // provenance for generated assets (today's Clip.generatedBy)
  generatedBy?: { provider: string; model?: string; prompt: string };
};
```

### Layer 2 — Semantic Analysis (new)

Each source file is decomposed into meaningful units. This is the layer that
makes AI editing different, and it is the biggest net-new piece.

```ts
type MediaSegment = {
  id: string;
  assetId: string;
  startMs: number;
  endMs: number;
  transcript?: TranscriptSpan[];
  visualDescription?: string;
  detectedObjects?: string[];
  sceneType?: "talking_head" | "b_roll" | "screen_recording" | "product_shot" | "title_card";
  audioFeatures?: { energy: number; silence: boolean; music?: boolean; speech?: boolean };
  qualitySignals?: {
    sharpness?: number; exposure?: number; audioClarity?: number;
    faceVisible?: boolean; cameraMotion?: "static" | "smooth" | "shaky";
  };
  semanticTags: string[];
};
```

Transcript is a **first-class editing surface**, not metadata (Descript-style:
edit the video by editing the text):

```ts
type TranscriptSpan = {
  id: string; assetId: string; startMs: number; endMs: number;
  speakerId?: string; text: string; words: WordTiming[];
};
type WordTiming = { word: string; startMs: number; endMs: number; confidence: number };

type TextEditOperation = {
  type: "remove_words" | "compress_pause" | "reorder_sentence" | "bleep" | "caption_emphasis";
  wordSpanIds: string[];
};
```

### Layer 3 — Story / Narrative Plan (promote today's `EditPlan`/`Beat`)

```ts
type StoryPlan = {
  id: string;
  objective: string;
  targetDurationMs: number;
  audience?: string;
  tone?: "educational" | "funny" | "cinematic" | "salesy" | "documentary";
  beats: StoryBeat[];
};

type StoryBeat = {
  id: string;
  role: "hook" | "context" | "problem" | "setup" | "demo" | "evidence"
      | "contrast" | "payoff" | "cta" | "outro";
  intent: string;
  targetDurationMs?: number;
  requiredContent?: { transcriptMeaning?: string; visualTags?: string[]; speaker?: string };
  emotionalShape?: { energy: "low" | "medium" | "high"; sentiment: "neutral" | "positive" | "tense" | "excited" };
};
```

This is the story arc the agent optimizes against. Today's `Beat` (`name`,
`durationSec`, `intent`) and `StoryContext` collapse into this layer.

### Layer 4 — Edit Decisions (promote today's `TimelineSegment.role/reason` + `Patch`)

The bridge between story and media: which segments satisfy which beats, and why.
Auditable by construction.

```ts
type EditDecision = {
  id: string;
  beatId: string;
  operation: "select_segment" | "trim" | "cut" | "insert_broll" | "overlay"
           | "transition" | "caption" | "music" | "sound_effect" | "effect" | "remove_silence";
  sourceSegmentIds: string[];
  rationale?: string;
  constraints?: {
    minDurationMs?: number; maxDurationMs?: number;
    mustIncludeWords?: string[]; avoidJumpCut?: boolean; preserveSpeakerContinuity?: boolean;
  };
  confidence?: number;
};
```

Transitions become **semantic events**, not just visual effects, with ranked
alternatives so detection ("here are possible cut points") is separated from
taste ("given this style, pick this one"):

```ts
type TransitionDecision = {
  id: string; fromBeatId: string; toBeatId: string;
  type: "hard_cut" | "jump_cut" | "match_cut" | "crossfade" | "audio_lead_in"
      | "audio_trail_out" | "smash_cut" | "scene_change" | "hidden_cut";
  timing: { cutAtMs: number; preRollMs?: number; postRollMs?: number };
  reason: "sentence_boundary" | "beat_change" | "visual_match" | "music_downbeat"
        | "motion_continuity" | "emotional_shift" | "remove_dead_air" | "hide_jump_cut";
  confidence: number;
  alternatives?: { type: string; cutAtMs: number; score: number }[];
};

type CandidateCut = {
  atMs: number; score: number;
  features: {
    sentenceBoundary: boolean; silenceBeforeMs: number; silenceAfterMs: number;
    visualMotionContinuity: number; musicBeatAlignment: number;
    facePoseChange: number; semanticShift: number;
  };
};

type EditPolicy = {
  pacing: "fast" | "balanced" | "slow";
  transitionStyle: "invisible" | "energetic" | "cinematic";
  tolerateJumpCuts: boolean;
  preferMusicSync: boolean;
};
```

Overlays are semantic-first, visual-second — anchored to phrases/objects/beats
rather than fixed pixel coordinates:

```ts
type Overlay = {
  id: string;
  role: "caption" | "lower_third" | "logo" | "callout" | "highlight"
      | "annotation" | "diagram" | "subtitle" | "reaction" | "comparison";
  intent: string;
  anchor: { type: "timeline_time" | "spoken_phrase" | "object" | "person" | "beat";
            refId?: string; phrase?: string; offsetMs?: number };
  layout: { region: "top" | "bottom" | "left" | "right" | "center" | "custom";
            avoidFaces?: boolean; avoidSubtitles?: boolean; safeArea?: boolean };
  content: { type: "text"; text: string } | { type: "image"; assetId: string }
         | { type: "shape"; shape: string } | { type: "generated"; prompt: string };
  style?: StyleRef;
};
```

### Layer 5 — Timeline (compiled, not authored)

Close to today's `Timeline`/`TimelineSegment`, but **derived** from the edit
graph instead of hand-authored. It may grow from a single segment list to
multi-track to express overlays, music, and captions, but it remains an output.

```ts
type Timeline = {
  id: string; fps: number; width: number; height: number; durationMs: number;
  tracks: Track[];
};
type Track = {
  id: string;
  type: "video" | "audio" | "text" | "effect";
  role: "primary_video" | "b_roll" | "voiceover" | "music" | "captions" | "graphics" | "sfx";
  zIndex?: number; items: TimelineItem[];
};
type TimelineItem = {
  id: string;
  source: { kind: "media"; assetId: string; sourceStartMs: number; sourceEndMs: number }
        | { kind: "generated_text"; text: string }
        | { kind: "generated_image"; assetId: string }
        | { kind: "effect" };
  timelineStartMs: number; timelineEndMs: number;
  transform?: { x: number; y: number; scale: number; rotation: number; opacity: number };
  effects?: EffectInstance[];
};
```

### Layer 6 — Render Plan (declarative, deterministic)

The AI should not handcraft ffmpeg as its canonical representation. ffmpeg is a
backend; the render plan is explicit and reproducible.

```ts
type RenderPlan = {
  engine: "ffmpeg" | "remotion" | "moviepy" | "custom_gpu";
  output: {
    format: "mp4" | "mov" | "webm";
    codec: "h264" | "h265" | "prores";
    width: number; height: number; fps: number; bitrate?: string;
  };
};
```

## Canonical Project Schema

```ts
type AIVideoProject = {
  id: string;
  assets: MediaAsset[];
  analysis: {
    segments: MediaSegment[];
    transcript: TranscriptSpan[];
    visualEntities: VisualEntity[];
    audioEvents: AudioEvent[];
    embeddings: EmbeddingRef[];
  };
  intent: CreativeBrief;
  story: StoryPlan;
  edit: {
    decisions: EditDecision[];
    transitions: TransitionDecision[];
    overlays: Overlay[];
    constraints: EditConstraints;
  };
  timeline: Timeline;   // compiled
  render: RenderPlan;
};

type CreativeBrief = {
  goal: string; audience?: string;
  platform?: "youtube" | "tiktok" | "instagram" | "x" | "linkedin" | "internal";
  targetDurationMs?: number; aspectRatio?: "16:9" | "9:16" | "1:1" | "4:5";
  tone?: string; styleRefs?: string[];
};

type EditConstraints = {
  maxDurationMs?: number; minDurationMs?: number;
  requiredBeats?: string[]; forbiddenContent?: string[];
  preserveChronology?: boolean; allowGeneratedMedia?: boolean;
  allowVoiceover?: boolean; allowMusic?: boolean;
};
```

## Why This Makes Revision Intelligent

Revisions in [API Contract V1](./api-contract-v1.md) and the
[OODA Feedback Loop](./ooda-feedback-loop.md) currently apply `Patch` ops to the
timeline. With the edit graph, a natural-language revision maps to the layer it
actually concerns:

- "Make it punchier" → operate on pauses, low-energy beats, redundant transcript
  spans, weak transitions, overly long establishing shots.
- "Make the story clearer" → operate on missing context beats, weak evidence,
  unclear transitions, unsupported claims.
- "Use a different opener" → reselect segments for the `hook` beat without
  disturbing the rest of the graph.

Each cut keeps its rationale, so the agent revises by reasoning, not by guessing:

```json
{
  "cutAtMs": 18620,
  "reason": "speaker completed sentence and there is a 220ms pause",
  "linkedTranscriptSpan": "span_42",
  "linkedBeat": "problem_statement",
  "alternatives": [
    { "cutAtMs": 18480, "score": 0.74 },
    { "cutAtMs": 18930, "score": 0.69 }
  ]
}
```

## Storage Implications

Extends [Project Model And Storage](./project-model-storage.md):

- **Immutable media store** — raw + generated files (object storage; local media
  dirs in `AUTH_MODE=local`).
- **Analysis store** — transcript, segments, audio/visual events, quality scores,
  embeddings. Structured metadata in Postgres; embeddings in a vector store;
  large analysis blobs in object storage.
- **Edit graph** — the main AI-editable JSON document (intent, story, decisions,
  transitions, overlays, constraints). Postgres JSONB with `schemaVersion` and
  derived columns, mirrored to local JSON files for dev.
- **Timeline + render** — compiled projections, regenerable from the edit graph;
  exportable to ffmpeg filter graphs, Remotion compositions, FCPXML, Premiere
  XML, or the custom renderer.

The edit graph is the durable source of truth; the timeline is cache-like.

## Proposed PR Sequence (incremental, non-breaking)

The timeline stays the compiled artifact throughout, so the renderer and current
UI keep working while layers are introduced underneath them.

### PR 1: Shared edit-graph types + schema versions

Add the layered TypeScript types (`MediaSegment`, `TranscriptSpan`, `StoryPlan`,
`EditDecision`, `TransitionDecision`, `Overlay`, `AIVideoProject`, etc.) as
shared schemas with versions. No behavior change. Document the mapping from
current `types.ts` to the new layers (this doc's table is the starting point).

### PR 2: Introduce the compiler (`editGraph -> Timeline`)

Add a pure function that compiles an edit graph into the existing `Timeline`
shape. Initially, synthesize a minimal graph from current planner output and
prove the compiler reproduces today's timelines byte-for-byte (golden tests).

Acceptance: existing renders are unchanged when produced via the compiler.

### PR 3: Persist the edit graph as the source of truth

Store the edit graph alongside the timeline; mark the timeline as derived. Reads
still serve the timeline; writes update the graph and recompile.

### PR 4: Lift rationale + story into the graph

Move `TimelineSegment.role/reason`, `Beat`/`EditPlan`, and `StoryContext` into
`StoryPlan` + `EditDecision`. Planner writes decisions; compiler emits segments.

### PR 5: Semantic analysis layer (transcript + segments)

Add transcript extraction and `MediaSegment` decomposition for uploaded/generated
assets. Expose transcript as an editing surface (text edits → edit decisions).

### PR 6: Re-express revisions as graph operations

Re-implement the `Patch`/revision path as edit-graph mutations with ranked
alternatives, then recompile. Natural-language revisions target layers, not raw
timecodes.

### PR 7: Declarative render plan

Make the renderer consume a `RenderPlan` produced from the graph, decoupling the
canonical model from ffmpeg specifics.

### Later

Multi-track timeline for overlays/music/captions, embeddings-based selection,
audio-event detection, and additional timeline projections (shot list, cutdowns).

## Open Decisions

- **Units:** adopt milliseconds in graph layers now (better cut precision) and
  convert at compile time, or migrate the whole codebase off `durationSec`
  first. This doc assumes the former.
- How much of the Semantic Analysis layer is required for v1 vs. introduced
  lazily (transcript first, visual/audio events later).
- Whether `StoryContext`/`CompositionPlan` are absorbed into `StoryPlan` or kept
  as adapters during migration.
- Whether the timeline grows to multi-track immediately or stays single-segment
  until overlays/music need it.
- How edit-graph `schemaVersion` migrations are handled for already-persisted
  projects.
- Whether revisions create sibling graphs (mirroring today's sibling-timeline
  rule in [API Contract V1](./api-contract-v1.md)) or version a single graph.

## Risks

- Net-new analysis (transcript, segmentation, embeddings) is real work and cost;
  the phased plan defers it so the graph lands before the analysis is complete.
- The compiler is load-bearing: if `editGraph -> Timeline` is wrong, every render
  is wrong. Golden tests against current timelines gate PR 2.
- Two representations (graph + timeline) can drift; the timeline must be strictly
  derived and never hand-edited once the graph is source of truth.
- Storing rationale/alternatives grows project size; keep large analysis in
  object storage and reference by ID.
- Over-modeling early. Start with the minimal graph (assets, transcript,
  segments, story beats, edit decisions, timeline) and grow.

## Acceptance Criteria

- The edit graph — not the timeline — is the persisted source of truth, and the
  timeline is reproducibly compiled from it.
- Current renders are unchanged after the compiler is introduced (golden tests).
- A cut/segment can be traced to the beat it serves, the transcript span it
  covers, and the rationale and ranked alternatives behind it.
- A natural-language revision ("punchier", "clearer", "different opener") maps to
  edit-graph operations on the relevant layer rather than blind timecode edits.
- New users and existing projects migrate without losing edit history, and the
  renderer consumes a declarative render plan rather than ad-hoc ffmpeg as the
  canonical model.

## PR 1 Implementation Mapping

The shared contract lives in `src/lib/edit-graph`:

- `types.ts` exports the layered TypeScript domain model.
- `schemas.ts` exports hand-written JSON schema objects for the same persisted
  shape.
- `EDIT_GRAPH_SCHEMA_VERSION` is `editGraph.v1`.
- `EDIT_GRAPH_PROJECT_SCHEMA_VERSION` is `aiVideoProject.v1`.

| Current type | New graph layer | Mapping |
| --- | --- | --- |
| `Clip` | `MediaAsset` | `id`, `url`, `kind`, `durationSec`, and generated provenance become immutable source media with millisecond duration and structured metadata. |
| `Clip.generatedBy` | `GeneratedMediaProvenance` | Provider/model/prompt are preserved on the asset rather than inferred from timeline usage. |
| `Beat` | `StoryBeat` | Beat name maps to semantic `role`, intent is preserved, and duration becomes `targetDurationMs`. |
| `EditPlan` | `StoryPlan` | Target length, audience/tone context, and beats become the narrative plan optimized by the agent. |
| `StoryContext` | `CreativeBrief` and `StoryPlan` | Brief fields describe intent; beat-level story details move into `StoryBeat.requiredContent` or emotional shape. |
| `TimelineSegment.role` | `StoryBeat.role` and `EditDecision.beatId` | The timeline role becomes a traceable relationship between a compiled segment and the story beat it serves. |
| `TimelineSegment.reason` | `EditDecision.rationale` and `TransitionDecision.reason` | Rationale is stored on the decision that caused the segment, trim, cut, transition, or overlay. |
| `Patch` | `EditDecision` | Revision operations become semantic graph mutations before recompiling a timeline. |
| `CriticReport` / `CriticScores` | Future graph analysis | Critic output can target story, analysis, decisions, or render constraints instead of only post-hoc timeline patches. |
| `CompositionPlan` / `CompositionPlannedBeat` | `StoryPlan` plus `EditDecision` | Asset strategy separates into beat intent and segment-selection decisions. |
| `Timeline` / `TimelineSegment` | `EditGraphTimeline` | Timeline becomes the compiled projection with millisecond timing and track/item structure. |

This PR intentionally does not compile or persist edit graphs. PR 2 should add
the pure `editGraph -> Timeline` compiler and golden tests showing existing
renders remain unchanged.
