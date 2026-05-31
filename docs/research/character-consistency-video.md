# Character Consistency For Generated Images And Video

This document summarizes the relevant implementation guidance from
`deep-research-report (13).md` in Downloads. The core conclusion is that
character consistency is not solved by one prompt. It requires a stack of
identity, style, structure, temporal, and quality controls.

## Operating Model

For Popcorn Ready, treat a recurring character as a first-class production asset:

- Character bible: the canonical description of identity, body/silhouette,
  wardrobe, palette, style, and non-negotiable invariants.
- Reference pack: curated images that show the character from useful angles and
  distances.
- Shot intent: the specific action, camera, lighting, emotion, and background
  that can change per generated asset.
- Provider adapter: provider-specific settings for reference images, seeds,
  first/last frames, model names, aspect ratio, and duration.
- QC record: human or automated checks for identity, wardrobe, style, and
  temporal drift.

The prompt pattern should be split into two blocks:

```text
[CHARACTER INVARIANTS]
Same named character, age range, face anchors, hair, build, silhouette,
wardrobe anchors, palette, and style anchors. Do not redesign the character.

[SHOT DELTA]
New pose/action, location, camera, lighting, emotion, and story beat.
```

The invariant block should be reused verbatim across still image, video, and
revision requests.

## Reference Strategy

Use references aggressively rather than relying on text-only prompts.

Recommended minimum reference pack:

- Front portrait.
- Three-quarter portrait.
- Profile or side view.
- Full body / silhouette.
- Optional style frame, if style drift is a problem.

For hosted APIs, this maps to multi-image reference inputs. For open pipelines,
this maps to IP-Adapter/InstantID/PhotoMaker-style identity adapters, ControlNet
for pose/depth/edges, and low-strength image-to-image or inpainting from a hero
frame.

## Provider Implications

### OpenAI Image

Use image editing or multi-image references when carrying a character forward.
Restate invariants on every request. Prefer edits or masked edits from a hero
image over fresh text-to-image after the character is established.

### Gemini / Google

Google image-generation guidance is especially relevant for recurring
characters because it supports multiple reference images. For video, use Veo
reference images and image-to-video/first-frame workflows where available.
Popcorn Ready should pass character reference assets to Gemini video generation when
creating character-driven clips.

### Open / Local Pipelines

If Popcorn Ready later supports local generation stacks, the highest-control route is:

- Fixed seed for exploration and reproducible local sweeps.
- Low-strength image-to-image from a hero frame.
- Masked inpainting for local edits.
- ControlNet for pose/depth/edges.
- IP-Adapter/InstantID/PhotoMaker for identity.
- LoRA or DreamBooth when a character must survive many poses, outfits, and
  camera angles.

LoRA is usually the best production compromise. DreamBooth can be stronger, but
is heavier and more prone to overfitting. Textual inversion is lighter but
usually weaker as a full character lock.

## Video Strategy

Video consistency fails in two ways:

- Shot-to-shot drift: the same character changes between generated clips.
- Frame-to-frame drift: the character flickers or changes inside one clip.

Popcorn Ready should initially optimize for shot-to-shot consistency by generating
short clips from consistent reference packs. Longer scenes should be assembled
from multiple short clips, not from one long unconstrained generation.

Recommended video workflow:

1. Create or select a hero still for the character.
2. Build a reference pack from the hero and alternate views.
3. Generate short 4-8 second clips with the same character reference pack.
4. For important cuts, use first-frame or first/last-frame controls where the
   provider supports them.
5. Keep scene deltas small: change action or camera or environment, not all at
   once.
6. Review generated clips for identity, wardrobe, style, and temporal drift.
7. Regenerate or repair only failing shots.

## Evaluation And QA

Automated metrics are useful but should not replace human review.

Minimum v1 human rubric:

- Face/identity: does the person or character read as the same?
- Silhouette/body: does body shape and scale remain plausible?
- Wardrobe/props: are signature clothing and accessories preserved?
- Style: does the render style match the project look?
- Temporal consistency: does the character flicker inside the clip?
- Scene compliance: did the shot delta happen without redesigning the character?

Future automated checks can include face similarity, perceptual similarity,
CLIP-style prompt alignment, and video consistency metrics. The report warns
that generic video metrics can miss identity flicker, so identity should be
measured separately from general visual quality.

## Common Failure Modes

| Failure | Likely cause | Product response |
|---|---|---|
| Face is stable but clothing drifts | Identity reference does not constrain wardrobe | Add wardrobe anchors and full-body references |
| Same prompt still drifts | Prompt-only control is too weak | Reuse hero image or reference pack |
| Same seed still drifts | Seed controls noise, not all identity uncertainty | Use image/reference conditioning |
| Strong identity lock makes every shot too similar | Reference/adaptor weight too high | Lower identity weight or vary pose/structure controls |
| Video flickers despite good stills | No temporal control | Use provider video references, first frames, or shorter clips |
| Fine-tune memorizes background/outfit | Training data leakage | Curate cleaner references and separate identity/style/wardrobe |

## Practical Defaults For Popcorn Ready

Initial implementation should avoid custom training and focus on provider-API
controls:

- Add character profiles and reference assets to the project model.
- Let users mark generated or uploaded images as character references.
- Pass selected character references into image/video generation requests.
- Auto-inject character invariant prompts into generation prompts.
- Track generated assets by `characterProfileId`.
- Add a lightweight consistency review checklist to generated assets.

Custom LoRA/DreamBooth training should remain out of scope until the hosted API
workflow proves insufficient for target use cases.
