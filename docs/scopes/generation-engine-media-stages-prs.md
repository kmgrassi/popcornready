# Generation engine: media stages — scope & parallel PR plan

## Goal

Make the **v1 generation job actually produce media**. Today `runGenerationJob`
runs `creative_plan → storyboard → timeline_assembly → quality_review` and
**never executes `asset_generation`, `audio_generation`, or `export`** — the only
working media path is the legacy one-shot monolith. This scope wires real
keyframe/clip/audio generation into the v1 run, in the right order, reusing the
primitives that already exist.

Target stage order (matches `docs/NORTH_STAR.md` — text first, then a model-gated
visual-anchor step, then media):

```
creative_plan (text)  →  storyboard (cheap sketches)
   →  [conditional] character_anchor   ← model decides from the plan
   →  asset_generation  (per beat: keyframe → clip)   ← BYO assets resolve here, generation only fills gaps
   →  audio_generation  (narration + soundtrack, parallel-friendly)
   →  timeline_assembly (selects from the pool, role-aware)
   →  quality_review  →  export  →  ready
```

## Two load-bearing principles

1. **Resolve-or-generate (bring-your-own assets).** A beat's media is *resolved*
   from the project asset pool first; generation only fills what isn't already
   there. A user-supplied clip/image (role `upload`, or any asset explicitly
   selected for a beat slot) **satisfies the beat and is never regenerated over.**
   This is the seam for the future "user brings their own footage/images" flow:
   such assets enter the pool (via the uploaded-footage entrypoint / a wizard
   step) and become active beat selections; `asset_generation` sees a filled slot
   and skips it. The engine treats generated and user assets identically once
   pooled — same role enum, same selection model.
2. **Per-beat durability.** Each keyframe/clip/anchor is pooled and selected as it
   completes (`addAsset` + `setSelection`), and emitted as a stage item. A resumed
   or partially-regenerated run recomputes **only** the beats whose slots are
   empty/invalidated — never the whole stage. This is the contract that lets the
   resumable-engine + feedback work in `docs/scopes/stepwise-story-generation-prs.md`
   apply at beat granularity.

## What already exists (reuse — do NOT reinvent)

- **Keyframe helpers** — `apps/api/src/lib/generative/keyframe.ts`: `buildKeyframePrompt()` (`:78`),
  `keyframeReferencePaths()` (`:132`, character anchor first, sketch as structural-only reference),
  `keyframeProvenanceInputs()` (`:152`), `selectClipFirstFrame()` + `assertPhotorealFirstFrame()`
  (`:52-72`, the guardrail that forbids `beat_storyboard` as a first frame).
- **Provider dispatch** — `apps/api/src/lib/generative/providers.ts` `providerFor(name)` (`:1-43`):
  openai/Sora, gemini, runway, ltx, nvidia/cosmos → each `.generateAsset()` for video.
- **Character anchor** — `apps/api/src/lib/api/v1/character-anchors.ts` `generateCharacterAnchor()`
  (`:85-156`), reuses `createGeneratedAsset` with `characterProfileIds` provenance, tags role
  `character_anchor`.
- **Asset pool + selection** — `apps/api/src/lib/assets/pool.ts`: `addAsset()`, `setSelection()`,
  `getSelection()`, `resolveActiveAsset()` (`:1-114`). Role enum in
  `packages/shared/src/assets/types.ts:21-35`: `character_anchor | scene_anchor | beat_storyboard |
  beat_keyframe | beat_clip | soundtrack | voiceover | upload`. Slot pattern: `slotKind=beat_keyframe`,
  `slotKey=beatId`, etc.
- **Stage/item progress** — `apps/api/src/lib/v1/generation-progress.ts`: `RunStageHandle.startItem({kind:
  "image"|"video"|"audio"})`, `item.succeed({assetId})`, `stage.succeed({resultArtifactId})`,
  `stageItemKindForAssetKind()` (`:274`), `STAGE_ORDER` (`:126`).
- **Audio** — `apps/api/src/lib/generative/providers/elevenlabs.ts` `createElevenLabsAudio()` (`:344`)
  → speech/dialogue/music/sound_effect.
- **Legacy reference flow** — `src/app/api/oneshot/route.ts:207-500` + `oneshot/media-generation.ts`:
  the exact, proven ordering (anchor → per-beat keyframe → clip; soundtrack in parallel; pool +
  select incrementally; optional snapshot review/regenerate). `generateBeatKeyframe` (`:309-383`),
  `generateBeatClip` (`:24-106`), `generateCharacterHeroFrame` (`:200-295`), `generateSoundtrack`
  (`:385-426`). **These live only in the legacy monolith — they must be ported to a shared lib.**

## What must be built

- **No single "generate beat keyframe/clip" entry in the shared lib** — only assembled pieces +
  legacy one-shot copies. Port them to `apps/api/src/lib/generative/`.
- **No automatic character detection** — the model lists `characterIds` in the plan (advisory) but
  nothing consumes it. Need plan → "does a recurring character need an anchor?" → get-or-create.
- **`asset_generation` / `audio_generation` / `export` are unexecuted** in `runGenerationJob`.
- **`timeline_assembly` is uploaded-footage-only** — it must select from the pool (generated +
  uploaded) with role awareness.

---

## Shared contracts

- **Beat media slots** (pool): `beat_keyframe`/`beatId`, `beat_clip`/`beatId`,
  `character_anchor`/`characterId`, `voiceover`/`beatId`, `soundtrack`/`"main"`.
- **Resolve-or-generate**: `resolveBeatAsset(project, slotKind, beatId)` returns the active pooled
  asset if a valid one is selected (incl. user `upload`s mapped to the beat); otherwise the caller
  generates, then `addAsset` + `setSelection`. Generation is gated on "slot empty or explicitly
  invalidated", never "always".
- **Ported generator signatures** (new `generative/` shared functions, provider-neutral):
  `generateBeatKeyframe({beat, beatIndex, totalBeats, style, aspectRatio, characterInvariants?,
  sketchAsset?, anchorAsset?, provider}) → {asset, path}`; `generateBeatClip({beat, firstFrameAsset,
  characterContext?, provider, ...}) → Asset`; `resolveOrCreateCharacterAnchor({project, plan,
  deps}) → Asset | null`; `generateNarration(...)` / `generateSoundtrack(...) → Asset | null`.
- **Resumability invariant** (shared with stepwise scope): re-entering `asset_generation` skips beats
  whose `beat_keyframe`+`beat_clip` slots are filled and valid; only empty/invalidated beats run.
- **Stage items**: every generated or resolved asset emits one stage item (`image` for keyframes,
  `video` for clips, `audio` for narration/music) so the Studio checklist shows per-beat progress.

---

## PRs

### PR G0 — Port media-generation primitives to a shared lib *(foundation)*
- **Files:** new `apps/api/src/lib/generative/beat-media.ts` (and `audio.ts`) — port
  `generateBeatKeyframe`, `generateBeatClip` (+ optional snapshot review/regenerate),
  `generateCharacterHeroFrame`, `generateSoundtrack`/narration out of `src/app/api/oneshot/
  media-generation.ts` into provider-neutral functions built on `keyframe.ts` + `providers.ts` +
  `elevenlabs.ts`. No pipeline wiring yet.
- **Constraint:** minor-safety rule still applies — character/keyframe images of minors use Gemini
  (OpenAI image-edit rejects photorealistic minors).
- **Done when:** the shared functions exist with unit coverage (injected fake providers), independent
  of the legacy one-shot. One-shot can later delegate to them (its retirement is a follow-up — it
  still powers the live landing-page flow).

### PR G1 — Resolve-or-generate resolver (bring-your-own assets) *(parallel after G0 contract)*
- **Files:** new `apps/api/src/lib/assets/resolve-beat-asset.ts`.
- **Work:** `resolveBeatAsset(project, slotKind, beatId)` over the pool selection model; treats a
  user `upload` (or any explicitly selected asset) as a filled slot. A small mapper to bind
  job-input asset IDs / user-provided clips to beat slots (so footage a user brings is honored before
  generation). Defines the gate `asset_generation` uses per beat.
- **Done when:** unit tests prove a filled/selected slot resolves (no generation) and an empty slot
  returns "needs generation"; a user `upload` selected for a beat is honored over any generated asset.

### PR G2 — `asset_generation` stage execution *(core; depends on G0 + G1, integrates G3)*
- **Files:** `apps/api/src/lib/v1/generation.ts` (add the stage between `storyboard` and
  `timeline_assembly`).
- **Work:** mirror the one-shot order: (1) [G3] conditional character anchor; (2) per beat —
  `resolveBeatAsset(beat_keyframe)` else `generateBeatKeyframe` (seeded by the storyboard sketch +
  anchor), pool+select; then `resolveBeatAsset(beat_clip)` else `generateBeatClip` from that keyframe
  (guardrail via `selectClipFirstFrame`), pool+select. Emit a stage item per keyframe (`image`) and
  clip (`video`); persist a stage artifact snapshot. Pool/select **after each beat** for durability.
- **Done when:** a prompt run produces pooled `beat_keyframe` + `beat_clip` assets per beat with
  active selections; per-beat progress shows in the run; beats with a pre-filled slot are skipped.

### PR G3 — Conditional character anchor (model-decided) *(depends on G0; lands with/under G2)*
- **Files:** new `apps/api/src/lib/generative/character-anchor-decision.ts`; consumed by G2.
- **Work:** read the plan's `characterIds` (and character profiles) to decide whether a recurring
  character needs a consistency anchor; `resolveOrCreateCharacterAnchor` (reuse
  `generateCharacterAnchor`) **before** any keyframe; thread `characterInvariants` +
  the anchor path into `buildKeyframePrompt`/`keyframeReferencePaths`. Runs only when warranted —
  no anchor for character-free content.
- **Done when:** a plan with a recurring character produces a `character_anchor` asset before
  keyframes and the keyframes reference it; a plan without one generates no anchor.

### PR G4 — `audio_generation` stage *(parallel after G0)*
- **Files:** `apps/api/src/lib/v1/generation.ts` (audio stage), reuse `generative/audio.ts` (G0).
- **Work:** generate narration/voiceover per beat and/or a soundtrack via ElevenLabs, pool as
  `voiceover`/`soundtrack`, emit `audio` stage items. Respect resolve-or-generate (a user-supplied
  music/VO asset is honored). Designed to run concurrently with visuals where the executor allows.
- **Done when:** runs produce pooled audio assets; user-supplied audio is honored.

### PR G5 — `timeline_assembly` consumes the pool (role-aware) *(depends on G2)*
- **Files:** `apps/api/src/lib/v1/generation.ts` (`:506-548`), `apps/api/src/lib/agent/index.ts`
  `selectClips` (`:252-328`).
- **Work:** feed `selectClips` the pooled `beat_clip` (and `upload`) assets with their `role`, not
  uploaded-footage-only; let the agent assemble from generated + brought clips. Surface `Asset.role`
  to the selection signal.
- **Done when:** the assembled timeline references generated `beat_clip`s and any user uploads, chosen
  by role/content.

### PR G6 — `export` stage execution *(depends on a timeline)*
- **Files:** `apps/api/src/lib/v1/generation.ts` (export stage); reuse the mounted
  `timelines/:timelineId/exports` render path.
- **Work:** execute the export stage (render the assembled timeline to a final artifact), emit an
  `export` stage item, persist the output. Back the missing `GET /workspaces/:id/outputs` list
  (cross-ref Studio redesign PR 9) so exports surface in Outputs.
- **Done when:** a completed run yields a downloadable output artifact listed under the workspace.

### PR G7 — Resumability + per-beat regeneration *(coordinates with stepwise scope Workstream A)*
- **Files:** `apps/api/src/lib/v1/generation.ts`, `generation-runs/progress-emitter.ts`.
- **Work:** on re-entry, `asset_generation` skips beats with valid filled slots (loads from pool);
  reject-with-feedback on a single beat invalidates just that beat's `beat_keyframe`/`beat_clip`
  selection and regenerates only it. Share the artifact/pool loaders with the fixed-engine resume in
  `stepwise-story-generation-prs.md` so they don't diverge.
- **Done when:** a resumed run recomputes only empty/invalidated beats; regenerating one beat leaves
  the others untouched (asserted by call-counting tests).

---

## Dependency graph & merge order

```
PR G0 (port primitives) ──┬─► PR G1 (resolve-or-generate)
                          ├─► PR G3 (character anchor)
                          ├─► PR G4 (audio stage)
                          └─► (consumed by) ──► PR G2 (asset_generation) ──► PR G5 (timeline from pool)
                                                      │                  └─► PR G7 (resumability)
                                                      └─► PR G6 (export) ◄── needs a timeline
```

- **Land first:** PR G0 (the shared generators everything calls).
- **Parallel after G0:** G1, G3, G4 (distinct files/concerns).
- **G2** integrates G0+G1(+G3) and is the main edit to `generation.ts` — the **merge hotspot**: G2,
  G4, G5, G6, G7 all touch `generation.ts`, so sequence them (G2 → G5/G6 → G7) or split the stage
  bodies into per-stage modules (`generation/stages/asset-generation.ts`, etc.) so they don't collide.
- **G7** shares loaders with `stepwise-story-generation-prs.md` Workstream A — same owner or build the
  loader once.

## Merge hotspots
- `apps/api/src/lib/v1/generation.ts` — touched by G2/G4/G5/G6/G7. **Strong recommendation:** in G2,
  extract each stage body into `apps/api/src/lib/v1/generation/stages/*.ts` and have `runGenerationJob`
  call them, so later stage PRs edit their own file (per `AGENTS.md` low-conflict convention).
- `agent/index.ts` `selectClips` — G5 here and `planEdit`/feedback in the stepwise scope; different
  functions, coordinate the file.

## Relationship to the other scopes
- **`stepwise-story-generation-prs.md`** — provides resume wiring, review gates, and the
  `review_feedback` channel. This scope provides the media stages those gates pause between and that
  feedback regenerates. **G7 ≡ the media half of that scope's resumable-engine Workstream A.**
- **`studio-redesign-prs.md`** — the wizard's Generate/Review/Export steps render whatever stages/
  items these media stages emit (incl. the conditional "Establishing character consistency" item).
  PR 9 there (workspace list routes) pairs with G6's output listing.
- **`docs/NORTH_STAR.md` / `story-flow-tools.ts`** — the `plan_visual_anchors` tool is the
  orchestrator-era form of G3; build G3's decision as a reusable function so the future tool loop can
  call the same logic.

## Risks / decisions
- **Cost/latency:** real per-beat keyframe+clip generation is the expensive path. Keep the
  storyboard sketch (cheap) as the gateable preview; gate `asset_generation` behind a review gate so a
  user approves the plan/sketches before media spend (the redesign's Generate step already exposes
  gate config).
- **Legacy one-shot:** G0 ports its logic; one-shot still serves the live landing page, so retiring it
  is a deliberate follow-up, not part of this scope. Until then, prefer G0 functions as the single
  source and have one-shot delegate to avoid drift.
- **Provider mix:** clip providers vary (Sora/Veo/Cosmos/Runway/LTX); keep provider selection in job
  input and default sensibly. Minor-safety: keyframes of minors must route to Gemini.
- **BYO assets scope dial:** G1 lands the resolver and honors uploads selected for beats now; the
  *user-facing* "assign my clip to this beat" UI is a later Studio step — the engine is ready for it
  via the pool/selection model the moment that UI exists.
