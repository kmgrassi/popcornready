# Character Consistency Generation Scope

## Objective

Allow Popcorn Ready to generate images and videos with recurring characters that remain
recognizable across shots, revisions, and provider calls.

This scope turns the research summary in
[`docs/research/character-consistency-video.md`](../research/character-consistency-video.md)
into product and API work.

## Product Principles

- Character consistency is project data, not just prompt text.
- References should be explicit, reusable, and visible in the UI.
- The system should separate identity invariants from per-shot changes.
- Generated character assets should be traceable to the reference pack and
  prompt version that produced them.
- V1 should use hosted provider reference controls before introducing custom
  LoRA/DreamBooth training.

## Data Model Additions

```ts
interface CharacterProfile {
  id: string;
  projectId: string;
  name: string;
  description: string;
  identityInvariants: string;
  styleInvariants?: string;
  wardrobeInvariants?: string;
  negativePrompt?: string;
  status: "draft" | "ready" | "archived";
  createdAt: string;
  updatedAt: string;
}

interface CharacterReference {
  id: string;
  characterProfileId: string;
  assetId: string;
  role:
    | "front_portrait"
    | "three_quarter"
    | "profile"
    | "full_body"
    | "style"
    | "wardrobe"
    | "hero_frame";
  quality: "candidate" | "approved" | "rejected";
  notes?: string;
}

interface GeneratedAssetCharacterBinding {
  assetId: string;
  characterProfileId: string;
  referenceIds: string[];
  promptInvariantVersion: string;
  consistencyReview?: CharacterConsistencyReview;
}

interface CharacterConsistencyReview {
  identity: "pass" | "needs_review" | "fail";
  wardrobe: "pass" | "needs_review" | "fail";
  style: "pass" | "needs_review" | "fail";
  temporal?: "pass" | "needs_review" | "fail";
  notes?: string;
}
```

For the current local JSON MVP, these can live under the project object:

```ts
interface Project {
  characterProfiles?: CharacterProfile[];
  characterReferences?: CharacterReference[];
}
```

Hosted production should persist these as workspace/project-scoped rows.

## UI Scope

### Character Panel

Add a project-level character panel with:

- Create/edit/delete character profiles.
- Name and short description.
- Identity invariant text.
- Wardrobe/style invariant text.
- Negative prompt / avoid-list.
- Reference asset picker from uploaded/generated image assets.
- Reference role labels: front, three-quarter, profile, full-body, style,
  wardrobe, hero frame.
- Readiness indicator showing whether a profile has enough approved references.

### Asset Library Integration

On every image/video asset card:

- Allow "Use as character reference."
- Show which character profile the asset belongs to.
- Show whether the asset is a reference, generated output, or rejected candidate.
- Show consistency review status for generated character assets.

### Generation UI

For image/video generation:

- Let the user choose zero or more character profiles.
- Auto-fill the invariant prompt block into the generation request.
- Keep the shot prompt focused on the per-shot delta.
- Show which reference images will be passed to the provider.
- Warn if a selected character has too few references.

## API Scope

### Character Profiles

Future `/api/v1` routes:

- `POST /api/v1/projects/:projectId/characters`
- `GET /api/v1/projects/:projectId/characters`
- `GET /api/v1/projects/:projectId/characters/:characterId`
- `PATCH /api/v1/projects/:projectId/characters/:characterId`
- `DELETE /api/v1/projects/:projectId/characters/:characterId`

### Character References

- `POST /api/v1/projects/:projectId/characters/:characterId/references`
- `PATCH /api/v1/projects/:projectId/characters/:characterId/references/:referenceId`
- `DELETE /api/v1/projects/:projectId/characters/:characterId/references/:referenceId`

### Generated Asset Request Additions

Extend generated asset creation with character consistency fields:

```json
{
  "provider": "gemini",
  "kind": "video",
  "prompt": "She opens the old lab notebook and looks toward the petri dish.",
  "characterProfileIds": ["char_fleming"],
  "characterReferenceIds": ["ref_front", "ref_three_quarter", "ref_hero"],
  "consistencyMode": "reference_pack",
  "shotDelta": {
    "action": "opens the old lab notebook",
    "camera": "slow push-in",
    "setting": "1928 laboratory",
    "emotion": "curious realization"
  }
}
```

Suggested `consistencyMode` values:

- `prompt_only`: inject invariants, no image references.
- `reference_pack`: inject invariants and pass approved reference assets.
- `hero_frame`: use one hero frame as the primary reference.
- `first_frame_video`: use a selected frame as the first frame for video.
- `fine_tuned`: future mode for LoRA/DreamBooth/custom model workflows.

## Provider Adapter Scope

### Shared Prompt Builder

Add a helper that composes:

```text
[character identity invariants]
[style / wardrobe invariants]
[shot delta prompt]
[negative prompt / avoid-list]
```

All character-aware generation should use this helper instead of ad hoc string
concatenation.

### OpenAI Image Adapter

- Pass approved character references as multi-image edit inputs when available.
- Prefer edit/reference workflows for character-aware images after a hero image
  exists.
- Restate "do not redesign the character" invariants on every request.

### Gemini Image/Video Adapter

- For video, pass approved character image references into Veo where supported.
- Prefer a hero-frame or first-frame workflow for shot sequences.
- Keep clips short and assemble longer sequences through the timeline.

### Mock Provider

- Include character metadata in mock output so tests can verify request shape
  without calling live providers.

## Jobs And Processing

Character-aware generation should become a job because reference preparation,
provider generation, and QC may all be slow.

Job steps:

1. Resolve character profiles and approved references.
2. Validate references are local/copied assets available to the provider.
3. Build invariant prompt and provider-specific request.
4. Generate asset.
5. Save asset and bind it to the character profile.
6. Run lightweight consistency review checklist.
7. Return generated asset and review status.

## Quality Review

V1 manual review fields:

- identity
- wardrobe
- style
- temporal consistency for video
- notes

V2 automated review candidates:

- Face similarity against reference pack.
- CLIP/text alignment against shot delta.
- Perceptual similarity for protected reference regions.
- Temporal flicker / identity drift scoring for video.

## Parallelizable PR Plan

The work should be split into three PR-sized tracks. PR1 is the shared contract
and should land first. PR2 and PR3 can start in parallel from PR1's branch once
the type shapes and route contracts are stable.

### PR1: Character Data Model, Store, And API Plumbing

Goal: make characters and references first-class project data without changing
provider behavior yet.

Primary scope:

- Add TypeScript types for `CharacterProfile`, `CharacterReference`,
  `GeneratedAssetCharacterBinding`, and `CharacterConsistencyReview`.
- Extend the local `Project` shape with optional `characterProfiles`,
  `characterReferences`, and generated asset character bindings.
- Add local-store helpers for creating/updating/deleting character profiles.
- Add local-store helpers for attaching/removing/promoting character references.
- Add route-level request parsing for character-aware generated asset fields:
  `characterProfileIds`, `characterReferenceIds`, `consistencyMode`, and
  `shotDelta`.
- Add a shared prompt builder that can compose invariant blocks plus shot delta,
  but keep provider adapters in pass-through mode for this PR.
- Store character binding metadata on generated assets when character fields are
  provided, even if the provider does not yet consume references.
- Add validation for missing character profiles, missing references, rejected
  references, and unsupported `consistencyMode` values.

Suggested files/areas:

- `src/lib/types.ts`
- `src/lib/store.ts`
- `src/lib/generative/types.ts`
- `src/lib/generative/character-context.ts` (new)
- `src/app/api/generate-assets/route.ts`
- New API routes if keeping character CRUD separate in the MVP.

Boundaries:

- Do not add UI beyond minimal API affordances.
- Do not call provider-specific reference APIs yet.
- Do not add automated visual identity scoring.

Acceptance criteria:

- A project can persist at least one character profile and multiple references.
- A generated asset can record character profile IDs, reference IDs,
  consistency mode, and prompt invariant version.
- Invalid character/reference IDs fail with clear 400-level errors.
- Existing non-character generation behavior remains unchanged.
- Unit or route-level tests cover prompt builder and validation behavior.

### PR2: Character Reference UI And Manual Review Workflow

Goal: let a human operator create, curate, and review character consistency in
the browser against the PR1 data model.

Primary scope:

- Add a character panel in the editor for create/edit/archive.
- Add fields for identity invariants, wardrobe/style invariants, and negative
  prompt.
- Add a reference picker from existing image assets.
- Let users label references as front, three-quarter, profile, full-body,
  style, wardrobe, or hero frame.
- Let users mark reference quality as candidate, approved, or rejected.
- Add "Use as character reference" action on image assets.
- Add "Promote to hero/reference" action on generated image assets.
- Add character selector to image/video generation controls.
- Show a readiness indicator for each profile, for example "needs 3 approved
  references".
- Add manual consistency review fields for generated assets: identity,
  wardrobe, style, temporal, notes.

Suggested files/areas:

- `src/components/Editor.tsx`
- New character-specific components under `src/components/`
- `src/app/api/project/route.ts` or character CRUD routes from PR1
- Existing asset cards and generated asset controls

Boundaries:

- UI can pass selected character fields to generation, but provider-specific
  image/video reference behavior belongs in PR3.
- Review is manual only.
- No custom training, face detection, embeddings, or automated scoring.

Acceptance criteria:

- A user can create a character profile from the UI.
- A user can attach at least three image references and label their roles.
- A user can select a character profile before generating an image or video.
- A generated asset shows which character profile and references were used.
- A user can mark generated outputs as pass/fail/needs review for identity,
  wardrobe, style, and temporal consistency.
- Rejected outputs cannot be promoted into the approved reference pack without
  changing their review state.

### PR3: Provider Reference Support And Regeneration Actions

Goal: make the generation providers actually consume the character references
and expose iteration actions that preserve identity.

Primary scope:

- Wire the shared prompt builder into provider requests.
- OpenAI image support:
  - Use approved character references as multi-image edit/reference inputs where
    supported.
  - Prefer edit/reference workflows after a hero frame exists.
  - Inject "do not redesign the character" invariants into every request.
- Gemini/Veo support:
  - Pass approved character reference images to Veo where the SDK/API supports
    image references.
  - Support hero-frame or first-frame video mode where available.
  - Keep generated character video clips short by default.
- Add provider capability checks so unsupported consistency modes fail clearly.
- Add "regenerate with same character" action that reuses the previous
  character profile, references, and invariant prompt version.
- Add "regenerate with same character but new shot delta" action.
- Store provider settings used for consistency: model, references, mode, seed if
  supported, duration, aspect ratio, and prompt invariant version.
- Add mock-provider behavior that echoes character metadata for tests.

Suggested files/areas:

- `src/lib/generative/providers.ts`
- `src/lib/generative/audio.ts` only if future voice-character consistency is
  included; otherwise leave audio out of scope.
- `src/lib/generative/character-context.ts`
- `src/app/api/generate-assets/route.ts`
- `src/components/Editor.tsx` only for regeneration buttons or minimal request
  fields not covered in PR2

Boundaries:

- No LoRA/DreamBooth/custom model training.
- No automated face similarity scoring.
- No long-video temporal repair or optical-flow post-processing.
- No hosted provider should silently drop requested character consistency
  controls; fail clearly instead.

Acceptance criteria:

- OpenAI image generation/editing can consume selected character references.
- Gemini/Veo video generation can consume selected character references where
  supported, or returns a clear unsupported-mode error.
- "Regenerate with same character" produces a new generated asset with the same
  character binding metadata.
- Generated assets record the exact references and invariant version used.
- Mock tests can verify the provider request received character metadata.
- Existing image/video/audio generation paths still work without character
  fields.

### Deferred PRs

The following work should be deferred until after PR1-PR3:

- Automated face similarity / identity scoring.
- Temporal flicker detection.
- LoRA, DreamBooth, textual inversion, or custom model training.
- Frame extraction / optical-flow repair pipelines.
- Consent/provenance enforcement beyond basic fields.
- Multi-character blocking, staging, and shot-level interaction constraints.

## Acceptance Criteria

- A user can create a character profile and attach at least three approved
  reference images.
- A generated asset can be explicitly tied to one character profile.
- The generator can create a new image or video prompt using the profile's
  invariant block and references.
- Generated assets store which references and prompt invariant version were
  used.
- The UI can distinguish references, candidate outputs, and approved outputs.
- A user can mark a generated character asset as pass/fail for identity,
  wardrobe, style, and temporal consistency.
- Unsupported provider/reference combinations fail with clear messages instead
  of silently dropping consistency controls.

## Open Questions

- Should Popcorn Ready create character profiles manually only, or auto-suggest them
  from repeated people/subjects in uploaded clips?
- Should reference packs allow real people, fictional characters, products, and
  mascots under one model, or should there be separate profile types?
- Do we need consent/provenance fields for real-person likenesses in v1?
- Should background music, voice, and character consistency live in one unified
  "production bible" object, or remain separate feature areas?
- Which provider should be the first fully supported character-consistency
  target: OpenAI image editing, Gemini/Veo video, or both?
