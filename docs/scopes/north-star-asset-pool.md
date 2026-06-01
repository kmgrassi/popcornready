# North Star Asset Pool Scope

> **Goal:** One project-scoped, persisted, self-describing asset pool — every
> anchor, keyframe, clip, and audio track is an immutable pooled `Asset`
> (`kind`/`role`/`projectId`/`provenance`/`depicts`); locations hold an **active
> selection** into the pool; nothing is throwaway.

## Status & sibling cross-refs

- **Status:** P0 design. No implementation. Aligns to `docs/NORTH_STAR.md`
  (authoritative). This is the **asset-pool** workstream of the North Star
  initiative.
- **This lane owns:** the unified persisted `Asset` shape, the pool, per-slot
  active selections, and folding the single-hero character into a
  character-typed anchor asset (retire single-hero).
- **Stay in lane — cross-reference, do not redo:**
  - **provenance-graph** owns stable IDs, input-edge recording, content
    fingerprints, and the staleness/blast-radius computation. This lane defines
    *where provenance lives* (on the `Asset`) and *what fields exist*, but the
    edge semantics, hashing, and invalidation are theirs. We consume their
    `assetId`/`beatId`/`anchorId` contract.
  - **store-consolidation** owns *where* the pool physically persists (collapsing
    `src/lib/store.ts` vs `src/lib/api/v1/store.ts`). This lane defines the
    in-memory pool abstraction and the `Asset` record; they own the read/write
    boundary and migration of the two stores into one.
  - **composition** owns the recursive composite-asset model (clip → scene →
    sub-video → movie). This lane makes "clip" and "audio" first-class pooled
    *atomic* assets and generalizes `clips[]` + `TimelineSegment.clipId` into a
    pool+selection; composition extends that same selection mechanism upward.
  - **unified-engine** / **orchestrator-tools** / **inspection-feedback** consume
    the pool (tools add assets and flip selections; the dashboard browses the
    pool). They do not define the `Asset` shape.

## North Star alignment

- **Principle 9 — "Nothing is throwaway; everything is persisted"**
  (NORTH_STAR.md:79). Today anchors/keyframes are temp files (see Current state);
  this lane makes them pooled assets — the audit trail of *why the agent did what
  it did*.
- **§5 "Assets live in a reusable pool; locations point at an active one"**
  (NORTH_STAR.md:181-191). The core deliverable: immutable pool items + per-slot
  active selection; regeneration adds, never deletes; idle assets stay reusable.
- **§5 "One project-scoped asset pool — not multiple stores"**
  (NORTH_STAR.md:192-204) and **§8 "Trunk for creative state — DECIDED"**
  (NORTH_STAR.md:252-257). Every asset carries `projectId`; relationships ride on
  the assets (self-describing) plus selections — no separate versioned-store
  collections.
- **§8 "Retire the single-hero character path — DECIDED"**
  (NORTH_STAR.md:269-272). Fold character into the anchor model (a character is
  an anchor with identity invariants); retire `generateCharacterHeroFrame` /
  single-`CharacterProfile`.
- **§5 "assets must be self-describing"** (NORTH_STAR.md:200-204):
  `kind` + provenance (what it was built from, by ID) + role/what-it-depicts. The
  prerequisite that lets the agent decide which asset feeds which call.

## Current state (grounded)

**One asset shape exists per surface, and they disagree.**

- **Browser store: `Clip`** (`src/lib/types.ts:118-141`) is the de-facto asset.
  It carries `kind?: "video"|"image"|"audio"`, `url`, `durationSec`,
  `description`, `source`, and rich per-asset provenance under `generatedBy`
  (`provider`/`model`/`prompt`/`providerPrompt`/`characterBinding`/`preflight`/
  `costUsd`) plus `characterBinding` (`src/lib/types.ts:97-116`). But it has
  **no `projectId`**, **no `role`**, **no `depicts`/subject**, and **no recorded
  input edges** (no `beatId`/`anchorIds`/`audioId`) — only the free-text prompt
  and character `referenceIds`.
- **The pool today is `Project.clips[]`** (`src/lib/types.ts:383`), a flat array,
  and the only "active selection" is **`TimelineSegment.clipId`**
  (`src/lib/types.ts:178-185`) — one slot kind (timeline segment) pointing at one
  clip. There is no generalized slot/selection concept for anchors or beats.
- **Agent v1 store: `V1Asset`** (`src/lib/api/v1/store.ts:50-68`) is the closest
  thing to the target: it already has `id`, `kind: AssetKind`
  (`src/lib/api/v1/schemas.ts:87`), `workspaceId`, **`projectId`**, `source`,
  `durationSec`, `context`, optional `semanticAnalysis`, and
  **`provenance: GeneratedAssetProvenance`** (`src/lib/api/v1/provenance.ts:25-36`,
  carrying `referenceAssetIds`, `characterBinding`, `providerSettings`,
  `requested/actualDurationSec`). **This is a strong seam to converge on.** But it
  lives in a *separate* store, lacks `role`/`depicts`, and the browser/oneshot
  path does not use it.

**Anchors and per-beat keyframes are throwaway files, not assets.**

- `generateCharacterHeroFrame` (`src/app/api/oneshot/media-generation.ts:128-212`)
  *does* produce a `Clip` (the hero anchor is at least a clip), hard-coding
  `projectId: "default"` into the draft (`media-generation.ts:164`).
- `generateBeatKeyframe`
  (`src/app/api/oneshot/media-generation.ts:219-257`) writes the per-beat image to
  `public/generated/keyframes/<id>.<ext>` (`media-generation.ts:20,252-256`) and
  **returns only the file path** — never a `Clip`, never persisted in
  `Project.clips[]`, never recorded as the first frame of the clip it seeds. It is
  passed as `firstFramePath` into `generateBeatClip`
  (`media-generation.ts:22-104`, `route.ts:307-320`) and then discarded. The
  resulting clip's provenance does **not** record which keyframe produced it.
- `GENERATED_DIR = public/generated` (`media-generation.ts:19`); clips/audio land
  there with `url: /generated/<file>` (`media-generation.ts:86-103,278-297`).

**Persistence & selection plumbing.**

- `saveProject` writes the whole `Project` (incl. `clips[]`) to
  `data/project.json` (`src/lib/store.ts:90-95`); `id` is hard-coded `"default"`
  (`store.ts:55`, `route.ts:460`). `addClip` just pushes onto `clips[]`
  (`store.ts:97-101`).
- The timeline is rebuilt from `clips[]` by index each save
  (`src/app/api/oneshot/project-cache.ts:33-50`, `route.ts:419-426`) — segment→clip
  is positional, not a durable selection the agent reasons over.
- "Resume" logic re-derives state from `clips[]` + goal-match
  (`project-cache.ts:84-144`), e.g. `resumableCharacterForGoal` finds an
  `approved` `hero_frame` reference — a hand-rolled stand-in for "active character
  anchor selection."

**Character model is bespoke and single-hero.**

- `CharacterProfile`/`CharacterReference` (`src/lib/types.ts:28-49`) and the
  one-shot helpers (`src/lib/oneshot/character-reference.ts`) build exactly one
  protagonist (`describeRecurringCharacter`, `buildOneShotCharacterDraft`); the
  hero image is a `Clip` with a `CharacterReference{ role: "hero_frame" }`. This
  is a parallel identity model that does not generalize to "anchors" and is the
  retire target per §8.

**Typed-but-unused dependency vocabulary.** `OverlayAnchor`
(`src/lib/edit-graph/types.ts:290-295`) is the only reference-by-id dependency
modeled (`beat|object|person|spoken_phrase|timeline_time` + `refId`); it is
aspirational and not wired to assets.

## Gap vs North Star

1. **No single asset type.** Three shapes (`Clip`, `V1Asset`,
   raw keyframe files) model "an asset." There is no one `kind`+`role`+`projectId`
   +`provenance`+`depicts` record.
2. **Throwaway intermediates.** Keyframes (and conceptually any future anchor not
   promoted to a `Clip`) are temp files outside the pool — violating Principle 9
   and breaking provenance (the clip can't name the keyframe it grew from).
3. **No `projectId` on the browser asset.** `Clip` is project-agnostic; the pool
   can't be project-scoped without it (§5).
4. **No explicit pool / active-selection abstraction.** `clips[]` is an
   accidental pool; `TimelineSegment.clipId` is the only selection, and only for
   timeline slots. Anchors/beats have no slot/selection concept, so "I like image
   10 — use it here" (§5) is impossible to express as data.
5. **Not self-describing.** No `role` (anchor vs keyframe vs clip vs audio vs
   character), no `depicts` (which beat/character/subject), no recorded input
   edges. The agent can't pick "which asset feeds which call" from the data.
6. **Single-hero character path** instead of a character-typed anchor (§8).

## Target design (design level, not code)

A single immutable record persisted in a per-project flat pool. Field names are
illustrative; the **provenance-graph** lane owns the precise input-edge and
fingerprint fields, and **store-consolidation** owns the physical schema.

- **`Asset` (unified, immutable, pooled).** A union of the three shapes above:
  - `id` (stable; provenance-graph contract) · `schemaVersion` · `projectId`
    (NEW on the browser path) · `kind: "image" | "video" | "audio"`.
  - `role`: what slot-class it serves — e.g. `character_anchor`,
    `scene_anchor`/`beat_keyframe`, `beat_clip`, `soundtrack`, `voiceover`,
    `upload`. (Generalizes `CharacterReferenceRole` and the implicit
    keyframe/clip/audio distinctions.)
  - `depicts`: the self-describing "what is this of" — `{ characterId?, beatId?,
    subject?, ... }`. (Replaces the positional/goal-match heuristics in
    `project-cache.ts`.)
  - `media`: `{ url, filename, durationSec?, measuredDurationSec? }` (from
    `Clip`).
  - `provenance`: the existing `GeneratedAssetProvenance`-shaped block
    (`provider`/`model`/`prompt`/`providerPrompt`/`preflight`/`costUsd`/
    `providerSettings`) **plus input-asset IDs** (`referenceAssetIds`,
    `beatId`, `anchorIds[]`, `firstFrameAssetId`, `audioId?`) — the keyframe a
    clip grew from becomes a recorded edge, not a lost file path. (Owned/extended
    by provenance-graph; this lane just declares the slots exist on the asset.)
  - `source: "upload" | "generated"`; immutable once written.
  - Optional `characterInvariants` for `role: character_anchor` (folds
    `CharacterProfile.identityInvariants`/`wardrobeInvariants`/`negativePrompt`
    onto the anchor asset — see character fold below).

- **`AssetPool` (per project).** Conceptually `Map<assetId, Asset>` for one
  `projectId`; **append-only, never delete** (§5, §8). Replaces `Project.clips[]`.
  Today's `addClip` becomes `addAsset`; the agent "pulls the project's pool and
  reasons over it by ID" (§5).

- **`Selection` / slots (active pointers into the pool).** A location is a
  `{ slotKind, slotKey, activeAssetId }` pointer. Slot kinds generalize
  `TimelineSegment.clipId`:
  - `timeline_segment` → keeps `segment.clipId` semantics (now
    `segment.activeAssetId`).
  - `character_anchor` → the active hero/likeness for a character (replaces
    `resumableCharacterForGoal`'s "approved hero_frame" scan).
  - `beat_keyframe` → the active first-frame image for a beat (replaces the
    discarded `firstFramePath`).
  - `beat_clip`, `soundtrack` → active media for that beat/track.
  Regeneration **adds** a new `Asset` and **flips** the slot's `activeAssetId`;
  the prior asset stays pooled and reusable elsewhere (§5). Versioning "falls out
  for free" (§8): assets immutable, selections move.

- **Character as a character-typed anchor (retire single-hero).** A character is
  an `Asset` with `role: character_anchor`, identity invariants on the asset, and
  `depicts.characterId`. The `character_anchor` slot holds the active likeness.
  Per-beat keyframes become `role: beat_keyframe` assets whose provenance records
  `anchorIds: [characterAnchorId]`. Retire `generateCharacterHeroFrame` /
  single-`CharacterProfile` (`media-generation.ts:128-212`,
  `src/lib/oneshot/character-reference.ts`) in favor of generating a
  `character_anchor` asset + selection.

- **Self-describing keyframes are no longer throwaway.** `generateBeatKeyframe`
  returns a pooled `Asset` (`kind: image`, `role: beat_keyframe`,
  `depicts.beatId`, provenance.anchorIds), sets the beat's `beat_keyframe`
  selection, and the beat clip's provenance records `firstFrameAssetId` →
  satisfies Principle 9 and gives provenance-graph a real edge.

## Work breakdown (ordered, PR-sized)

1. **PR A — Define the `Asset` type + read-compat shims (no behavior change).**
   Add the unified `Asset`/`role`/`depicts` types to `src/lib/types.ts`
   (or a new `src/lib/assets/types.ts`) alongside `Clip`; provide
   `clipToAsset`/`assetToClip` adapters. No call sites change yet.
   *Effort: S.* Depends on provenance-graph's ID/edge field names being stubbed.

2. **PR B — Add `projectId` to assets and stamp it on every generated asset.**
   Thread `projectId` into `generateBeatClip`/`generateCharacterHeroFrame`/
   `generateBeatKeyframe`/`generateSoundtrack`
   (`src/app/api/oneshot/media-generation.ts`) and the v1 generated-assets path;
   stop hard-coding `"default"` (`media-generation.ts:164`). *Effort: S.*

3. **PR C — Introduce the pool + selection abstraction over `clips[]`.**
   Wrap `Project.clips[]` as an `AssetPool` (append-only) and add a `selections`
   map; make `TimelineSegment` resolve via selection. Keep `clips[]` as a derived
   view for back-compat. Update `addClip`→`addAsset` in `src/lib/store.ts` and the
   positional rebuild in `src/app/api/oneshot/project-cache.ts:33-50`. *Effort: M.*

4. **PR D — Persist keyframes as pooled assets + record the edge.**
   `generateBeatKeyframe` returns an `Asset` (not a path); route
   (`src/app/api/oneshot/route.ts:307-320`) adds it to the pool, sets the
   beat_keyframe selection, and records `firstFrameAssetId` on the clip's
   provenance. Remove the throwaway `KEYFRAME_DIR` path-only flow
   (`media-generation.ts:20,252-256`). *Effort: M.* Depends on PR C.

5. **PR E — Fold character into a `character_anchor` asset; retire single-hero.**
   Replace `generateCharacterHeroFrame` + `CharacterProfile` single-hero usage
   with a `character_anchor` `Asset` + `character_anchor` selection; migrate
   `resumableCharacterForGoal` (`project-cache.ts:120-144`) to read the selection.
   Deprecate the bespoke `src/lib/oneshot/character-reference.ts` identity model.
   *Effort: M-L.* Depends on PR C.

6. **PR F — Converge `Clip` and `V1Asset` onto `Asset`.** Make the v1
   generated-assets path emit the unified `Asset`; coordinate with
   store-consolidation for the physical merge. Retire `Clip` as a distinct type
   once call sites read `Asset`. *Effort: L.* Depends on PRs A-E and
   store-consolidation.

## Dependencies & sequencing

- **Hard prerequisite from provenance-graph:** stable asset/beat/anchor IDs and
  the input-edge field contract. PR A can stub these but must converge before
  PR D/F. Coordinate the exact provenance field names there (single source of
  truth) to avoid a schema fork.
- **Hard prerequisite from store-consolidation for PR F:** the single physical
  pool store. PRs A-E can ship against the current `data/project.json` +
  `.local/agent-store.json` split; PR F is gated on consolidation.
- **Composition** builds on PR C's selection mechanism (composite = a selection
  of child asset IDs); do not model composites in this lane — expose the slot
  primitive they extend.
- **Internal order:** A → B → C → (D, E in parallel) → F.

## Risks & open questions

- **Two stores, two asset shapes.** Converging `Clip` and `V1Asset` (PR F) is the
  riskiest step; mitigated by adapters (PR A) so call sites migrate incrementally.
  Owned jointly with store-consolidation — confirm the boundary before PR F.
- **Provenance field ownership.** This lane and provenance-graph both touch the
  provenance block. **Open:** who owns the canonical `provenance` type? Proposal:
  provenance-graph owns it; asset-pool re-exports and only adds `role`/`depicts`.
- **Back-compat of `data/project.json`.** Adding `projectId`/pool/selections needs
  a read-time migration of existing files (`getProject` at `store.ts:79-88`).
  **Open:** migrate in place vs. version + lazy upgrade (lean toward lazy upgrade,
  matching the v1 `schemaVersion` pattern).
- **`role` taxonomy churn.** The role set (`character_anchor`/`beat_keyframe`/…)
  will grow as composition lands. **Open:** keep `role` an open string with a
  documented known-set, or a closed union? Lean open-string to avoid blocking
  composition.
- **Retiring single-hero** may regress the current resume/character-consistency
  behavior. Mitigate with a parity test on `resumableCharacterForGoal` semantics
  before deleting `character-reference.ts`.
- **"Active selection" vs timeline rebuild.** Today the timeline is rebuilt
  positionally each save; introducing durable selections must not double-source
  truth. **Open:** make the timeline a *pure projection* of selections (preferred,
  aligns with §5 "timeline remains a pure projection", NORTH_STAR.md:165) — but
  that overlaps unified-engine; coordinate.
