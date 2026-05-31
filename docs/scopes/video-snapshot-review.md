# Video Snapshot Review Scope

## Goal

Add an automated review pass that checks generated video clips against the
story beat, full arc, and character-consistency requirements before final
assembly.

This is intentionally snapshot-based for the first version. If provider APIs do
not reliably accept generated video as model input, Popcorn Ready can extract a
small set of still frames from each clip and send those images to a multimodal
review model.

## Proposed Flow

1. Generate or reuse the one-shot plan, character profile, and hero-frame
   reference.
2. Generate each beat clip.
3. Extract three snapshots per clip with code:
   - early frame: 20% of clip duration
   - middle frame: 50% of clip duration
   - late frame: 80% of clip duration
4. Send the snapshots plus structured context to a reviewer model:
   - full user prompt
   - full beat map
   - current beat name and intent
   - character invariants
   - hero-frame reference image
   - provider prompt used for that clip
5. Ask the reviewer for structured output:
   - `story_match`: pass / needs_review / fail
   - `character_match`: pass / needs_review / fail
   - `visual_quality`: pass / needs_review / fail
   - `continuity_notes`
   - `recommended_action`: keep / regenerate / manual_review
6. Persist the review on the generated asset as `consistencyReview` plus a
   broader generation-review result.
7. Before final assembly, regenerate failed clips when retry budget allows.

## Snapshot Extraction

Use the local media pipeline instead of asking providers to inspect video
directly.

Candidate implementation:

```text
ffmpeg -ss <timestamp> -i <clip.mp4> -frames:v 1 <snapshot.png>
```

The route should not shell out inline forever. Wrap this in a small utility that
can later move to the async jobs pipeline.

## Reviewer Prompt Shape

The reviewer should receive explicit context rather than vague pronouns:

```json
{
  "fullStoryArc": "...",
  "beatMap": ["1. Hook: ...", "2. Production: ..."],
  "currentBeat": {
    "index": 2,
    "name": "Production montage",
    "intent": "The same protagonist moves from idea to production."
  },
  "characterInvariants": "...",
  "providerPrompt": "...",
  "images": {
    "heroReference": "hero-frame image",
    "snapshots": ["20%", "50%", "80%"]
  }
}
```

## First PR Cut

- Add snapshot extraction utility.
- Add model-agnostic `reviewGeneratedVideoSnapshots()` interface.
- Implement one reviewer provider using the best configured multimodal model.
- Run review after each clip generation in one-shot.
- Save review results on clips without failing the whole generation.
- Gate automatic regeneration behind a small retry budget.

## Open Questions

- Which model should be the first reviewer: Gemini multimodal or OpenAI vision?
- Should the review run synchronously in one-shot, or only in the async job
  pipeline?
- How strict should automatic regeneration be for story mismatch versus
  character mismatch?
- How should the UI expose clips that pass generation but need visual review?
