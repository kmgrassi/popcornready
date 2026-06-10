# Storyboard & Scenes — Scope

## Objective

Two linked changes that turn the plan from an invisible beat list into a real,
visible storyboard:

1. **A Scene tier** — model the storyboard as relational
   **Storyboards → Scenes → Beats → Panels**. A scene is the continuity unit: a
   shared setting, cast, and look that its beats inherit.
2. **Visual storyboard tiles** — generate a **sketch-style image per beat** so the
   user can *see* how the video is sketched out before committing to expensive
   photoreal generation. Rendered deliberately as rough storyboard panels (pencil/
   marker linework) so it reads like a real storyboard, not a finished frame.
3. **A continuous sketch→final path** — the approved sketch **seeds the photoreal
   keyframe** (which is the clip's first frame), so the storyboard isn't a
   throwaway preview but the compositional reference for the real video.

Together these make the plan an **inspectable, editable, cheap pre-visualization**
that gates the costly asset stage — directly in line with
[NORTH_STAR](../NORTH_STAR.md) (artifacts you can inspect/gate/re-trigger, recompute
only what changed).

## Where we are today (grounding)

- The plan is **flat**: `EditPlan { targetLengthSec, style, aspectRatio, beats:
  Beat[] }`, `Beat { id?, name, durationSec, intent }`
  (`packages/shared/src/types.ts:171,181`). **No Scene object, no `sceneId`.**
- A scene concept already **leaked into the asset layer**: `AssetRole` includes
  **`scene_anchor`** (and it's the default role for images) alongside
  `character_anchor`, `beat_keyframe`, `beat_clip`
  (`packages/shared/src/assets/types.ts:21`). So the system gestures at scenes
  without ever modeling them as structure.
- Plan is produced by `planEdit()` (`apps/api/src/lib/agent/index.ts`, schema in
  `apps/api/src/lib/agent/schemas.ts`) in the `creative_plan` stage
  (`apps/api/src/lib/v1/generation.ts`). Per-beat images already exist
  (`beat_keyframe`, generated via `apps/api/src/lib/generative/`), but they're
  **photoreal first-frames**, generated in the expensive asset stage — not cheap
  sketch previews, and not shown for review.
- "Storyboard" exists only as a stray comment in
  `apps/api/src/lib/generative/preflight.ts`. No first-class concept.

---

## Part A — The Scene tier (data model)

Storyboard = ordered **Scenes**, each containing ordered **Beats**. The scene
carries the shared context its beats inherit.

```
EditPlan {
  targetLengthSec, style, aspectRatio,
  scenes: Scene[]
}

Scene {
  id: string;                 // stable, like Beat.id
  name: string;               // "Setup", "The reveal", …
  setting?: string;           // location / time / environment
  mood?: string;              // lighting, tone
  characterIds?: string[];    // cast present in this scene
  anchorAssetId?: string;     // the scene_anchor image (establishing look)
  beats: Beat[];              // ≈ shots; inherit the scene's setting/cast/look
}
```

Notes & decisions:

- **Beat ≈ shot.** Our existing "beat" (one beat → one keyframe → one clip) sits
  at the shot level; a scene grouping several beats matches film convention.
- **Hard nesting vs. soft tag.** Recommend **hard nesting** (`scene.beats[]`) — it
  models continuity and scene-level operations cleanly. Alternative: keep a flat
  `beats[]` and add `beat.sceneId` + a parallel `scenes[]` (less invasive, weaker).
  §Open decisions.
- **Inheritance drives continuity.** A beat's generation prompt is composed from
  **scene context + beat intent** (+ character anchors), so beats in a scene share
  a setting/look instead of each re-rolling its own world — a direct lever on the
  consistency problem the codebase already fights (`character_anchor`/`scene_anchor`).
- **`scene_anchor` gets an owner.** The existing `scene_anchor` asset role becomes
  the scene's establishing image (`Scene.anchorAssetId`), so the latent role finally
  attaches to a real object.
- **Provenance/graph.** A scene is a node: `beat asset → depends on → scene anchor
  → depends on → scene`. Editing a scene's setting recomputes only that scene's
  beats (NORTH_STAR recompute-affected).
- **Optional/auto for short clips.** The planner may emit a **single implicit
  scene** for a 15–30s clip, so we don't force hierarchy onto tiny videos. Scenes
  earn their keep on multi-setting / longer / narrative content.
- **Migration (clean break, no compat shim — [[no-legacy-compat-code]]):** flat
  `EditPlan.beats` → `scenes: [{ …, beats }]`; existing plans wrap their beats in
  one scene. `planEdit` + `planSchema` emit scenes→beats; consumers
  (asset_generation loop, timeline_assembly, critique/revise) iterate
  scenes→beats.

---

## Part B — Visual storyboard tiles (sketch pre-viz)

Generate a **sketch image per beat** — the storyboard panels — fast and cheap, so
the whole plan is visible before any photoreal generation.

- **New asset role `beat_storyboard`** (add to `AssetRole`) — a rough sketch tile
  linked from `storyboard_panels.image_asset_id`. Distinct from `beat_keyframe`
  (photoreal first frame) and `beat_clip`. The image lives in the project asset
  pool with provenance like any other asset; panel order, status, approval, and
  selected state live in `storyboard_panels`.
- **One panel per beat** (recommended), grouped by scene; the **scene_anchor** can
  be rendered as the scene's establishing sketch.
- **Sketch aesthetic.** A "storyboard sketch" **style preset** layered onto the
  image prompt: rough pencil/marker linework, grayscale or limited palette, panel
  framing, optional motion arrows. The point is it *looks* like a storyboard, not a
  finished frame — which also sets user expectations ("this is a sketch of the
  plan").
- **Cheap & fast.** Low-res, fast image path so the full storyboard renders in
  seconds and **before** the expensive `beat_keyframe` + `beat_clip` stage. New
  generator alongside the existing keyframe path in
  `apps/api/src/lib/generative/` (provider per [[openai-image-minor-safety-block]]:
  sketches are non-photoreal, but still route any minor likeness through Gemini).
- **Consistency within a scene.** Tiles condition on the scene anchor (sketch) +
  character anchors (sketch form) so panels in a scene share style and character
  likeness.
- **Provenance.** `storyboard_panels` owns the product row; `asset_edges` records
  that the `beat_storyboard` image asset depends on the beat asset, scene/anchor
  context, and prompt asset. Editing a beat/scene regenerates only the affected
  tiles — cheap.

---

## Part C — Sketch → photoreal keyframe (the bridge)

The approved sketch isn't thrown away — it **seeds the photoreal `beat_keyframe`**,
so the storyboard the user approved becomes the compositional reference for the
final frame. What you sketched is what you get, rendered for real.

**Critical guardrail — the sketch must never become the clip's literal first
frame.** Verified in the current pipeline: the video providers use
**image-to-video** and the reference image becomes the **first frame** of the clip
(`apps/api/src/lib/generative/providers/ltx.ts:51` → `/image-to-video`;
`runway.ts:78` → `/image_to_video`; the `first_frame_video` consistency mode in
`character-context.ts`; provenance tracks the clip's `firstFrameAssetId`). So
whatever image is handed to the clip generator *is* frame 1. The chain must be:

```
beat_storyboard (sketch) ──seeds──▶ beat_keyframe (PHOTOREAL) ──first frame──▶ beat_clip
        ▲ never passed to image-to-video          ▲ this is the firstFrameAssetId
```

Requirements:

- The sketch conditions **composition / framing / blocking only** (pose, layout,
  camera, character placement); the keyframe is re-rendered **fully photoreal**.
  The pencil/line aesthetic must **not** survive into the keyframe — because the
  keyframe is the first visible frame of the clip.
- The seeding **mechanism is provider-dependent** (structural/ControlNet-style
  conditioning vs. low-retention img2img vs. sketch-as-reference + a strong
  photoreal prompt) — §Open decisions. Whatever the mechanism, the **acceptance
  guardrail is fixed**: the image passed as the clip's first frame
  (`firstFrameAssetId`) is always the photoreal `beat_keyframe`, **never** the
  `beat_storyboard`.
- Provenance: `beat_keyframe depends on beat_storyboard` (sketch is an input edge),
  so re-approving an edited sketch recomputes that beat's keyframe → clip only.

---

## Part D — The storyboard view (UI)

A first-class storyboard surface in the SPA (`apps/web`):

- **Scenes as sections/rows**, **beats as tiles** within: sketch image + beat name +
  duration + intent (one-line). Reads top-to-bottom as the video.
- **Editable plan:** reorder/add/remove/reword/re-time beats and scenes; edit a
  scene's setting/cast/mood; **regenerate a tile**. Each edit recomputes only the
  affected tiles.
- **"Generate video"** proceeds from the approved storyboard to full asset
  generation (keyframes + clips), per beat, recomputing only what changed.
- **Integration with the Studio redesign** ([studio-dashboard-redesign.md](./studio-dashboard-redesign.md)):
  the storyboard is the natural step in the **New Project flow** between "describe
  the goal" and "generate," and a **tab inside ProjectEditor**. (The New Project
  flow already drives the V1 run model; storyboard slots in as the gate before the
  costly stage.)

---

## Pipeline placement

A new **`storyboard`** stage between planning and asset generation, acting as a
review gate:

```
brief_intake
  → creative_plan        (now emits Scenes → Beats)
  → storyboard           (sketch tiles per beat; REVIEW/EDIT GATE)   ← new
  → asset_generation     (photoreal keyframes + clips, per beat)
  → audio_generation → timeline_assembly → quality_review → export
```

Add `storyboard` to `GenerationStageType` and the run orchestration
(`apps/api/src/lib/v1/generation.ts`); it's gateable like the existing
`creative_plan` review gate. Fast users can auto-pass it; deliberate users review
and edit before spending on full generation.

---

## PR breakdown

1. **Scene tier in the plan model.** Add `Scene` + `scenes: Scene[]` to
   `EditPlan` (`packages/shared`); update `planSchema` + `planEdit` to emit
   scenes→beats; migrate flat beats → single implicit scene; update consumers
   (asset_generation loop, timeline_assembly, critique/revise) to iterate
   scenes→beats. **Backend only, no tiles/UI.** Attach `scene_anchor` to
   `Scene.anchorAssetId`.
2. **Storyboard sketch tiles (generation).** Add `beat_storyboard` `AssetRole` +
   a sketch style preset + a fast/cheap tile generator in
   `apps/api/src/lib/generative/`; new `storyboard` generation stage producing one
   tile per beat; provenance wiring (`depicts beatId`, depends on intent + scene
   context).
3. **Scene/character sketch anchors + continuity.** Generate sketch-form scene
   anchors + character anchors; condition beat tiles on them so panels in a scene
   are stylistically consistent.
4. **Sketch → photoreal keyframe seeding (the bridge).** The approved
   `beat_storyboard` conditions the photoreal `beat_keyframe` (composition/blocking
   only, re-rendered photoreal). Wire the provenance edge (keyframe depends on
   sketch) and the **first-frame guardrail**: the clip's `firstFrameAssetId` is
   always the photoreal keyframe, never the sketch (Part C).
5. **Storyboard view (read-only).** `apps/web` storyboard surface: scenes →
   beat-tile grid with sketches, names, durations, intents. Wire to the run's
   storyboard artifacts.
6. **Storyboard editing.** Reorder/add/remove/reword/re-time beats & scenes; edit
   scene context; regenerate a tile; recompute-only-affected.
7. **Pipeline gate + New Project integration.** Wire `storyboard` as a review gate;
   integrate as the step between "describe" and "generate" in the New Project flow
   and as a ProjectEditor tab.

Dependencies: PR1 → PR2 → PR3 → PR4 → (PR5 → PR6) → PR7.

---

## Open decisions

- **Scene nesting**: hard `scene.beats[]` (recommended) vs. soft `beat.sceneId` +
  parallel `scenes[]` (Part A).
- **Tile granularity**: one panel per beat (recommended) vs. per-scene only vs.
  allow multiple panels per beat (a beat with a camera move = 2 panels).
- **Sketch style**: one fixed storyboard style vs. a few user-selectable styles
  (pencil / line-art / grayscale / loose color). Could ride the existing
  style/theme system.
- **Gate behavior**: storyboard as a **mandatory** review step vs.
  **optional/skippable** (fast path straight to generation).
- **Seeding mechanism**: how the sketch conditions the photoreal keyframe —
  structural/ControlNet-style vs. low-retention img2img vs. sketch-as-reference +
  a strong photoreal prompt — given providers differ (LTX/Runway/Gemini). The
  *guardrail* (the keyframe, never the sketch, is the clip's first frame) is fixed;
  only the mechanism is open (Part C).
- **Cost/provider for tiles**: which image model + resolution; confirm sketches of
  minors still route through Gemini per [[openai-image-minor-safety-block]].
- **Scenes auto vs. authored**: planner always emits scenes, vs. user can collapse
  to a single scene for short clips.

_Resolved during scoping:_ storyboard = **Scenes → Beats** (a scene is the
continuity tier above beats; beat ≈ shot); storyboard is made **visible** via
cheap **sketch tiles** (`beat_storyboard`) that gate the expensive asset stage;
the approved sketch **seeds the photoreal keyframe** (sketch→final bridge, now a
core PR) with a hard guardrail that the photoreal keyframe — never the sketch — is
the clip's first frame (the video path is image-to-video); integrates with the
Studio New Project flow as the pre-generation review step.
