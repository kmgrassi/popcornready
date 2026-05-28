# Audio generation scope

This pass standardizes a first audio-generation layer around ElevenLabs. The
goal is to let the app and future agent APIs create local audio assets that can
later be mixed into exports.

## Provider

ElevenLabs is the initial audio provider. It is exposed through the existing
generative asset abstraction as:

- `provider: "elevenlabs"`
- `kind: "audio"`
- `audioMode: "speech" | "dialogue" | "sound_effect" | "music"`

Required local environment:

```bash
ELEVENLABS_API_KEY=...
```

Optional default voice:

```bash
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
```

## Helper functions

The helper layer lives in `src/lib/generative/audio.ts`:

- `createSpeechAudio` creates narration from text.
- `createDialogueAudio` creates multi-speaker dialogue from text and voice IDs.
- `createSoundEffectAudio` creates short effects or ambience from text.
- `createMusicAudio` creates music from text prompts.
- `createElevenLabsAudio` dispatches by `audioMode`.

The functions return the same `GeneratedAssetResult` shape as image and video
generation, so API routes can save the returned bytes without provider-specific
logic.

## Current behavior

`POST /api/generate-assets` now accepts audio requests and writes generated
files to `public/generated/` with an `aud_` ID prefix. Generated audio is added
to the local project clip library with `kind: "audio"` and provider metadata.

Audio assets are intentionally excluded from visual clip-selection prompts and
ignored by the current Remotion visual timeline renderer. This prevents the MVP
planner from trying to use an MP3 as a video segment before timeline audio
tracks exist.

## Follow-up scope

- Add explicit timeline audio tracks for narration, music, ambience, and sound
  effects.
- Mix timeline audio in Remotion exports with gain, fade, ducking, and trim
  controls.
- Add UI controls for generating narration, sound design, and music.
- Add duration probing for generated audio files instead of relying on caller
  supplied `durationSec`.
- Add API endpoints for agents to create audio assets independently from the UI.
