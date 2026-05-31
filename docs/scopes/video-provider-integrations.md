# Video Provider Integrations

## Context

The May 2026 video-model research report ranks these production-relevant
families:

- Google Veo 3.1
- Kling VIDEO 3.0 Omni
- Runway Gen-4.5
- Seedance 2.0
- LTX-2.3
- Wan 2.1 VACE

Popcorn Ready already has working provider paths for Google Veo through Gemini
and OpenAI Sora. This scope tracks how to integrate the rest without hiding
provider-specific constraints.

## Implemented In This Pass

### Runway

Provider key: `runway`

Environment:

- `RUNWAYML_API_SECRET`
- fallback alias: `RUNWAY_API_KEY`

Supported:

- Text-to-video through Runway `POST /v1/text_to_video`
- Image-to-video through Runway `POST /v1/image_to_video` when a local
  reference path is present
- Polling `GET /v1/tasks/:id`
- Downloading the first returned output URL into Popcorn Ready storage
- Duration normalization to 5 or 10 seconds for the current Gen-4.5 endpoint
  limits

Default model:

- `gen4.5`

Why this matters:

- Covers Runway Gen-4.5 directly.
- Gives us a likely path for Seedance through Runway if the workspace has model
  access and the requested model name is supported.

### LTX

Provider key: `ltx`

Environment:

- `LTX_API_KEY`

Supported:

- Text-to-video through LTX `POST /v1/text-to-video`
- Image-to-video through LTX `POST /v1/image-to-video` when a local reference
  path is present
- Data URI references for local image inputs

Default model:

- `ltx-2-3-fast`

Notes:

- LTX supports data URI media inputs with size limits, so local hero/reference
  images can be passed without first uploading them.
- This implementation requests silent video (`generate_audio: false`) because
  Popcorn Ready already has a separate soundtrack/audio pipeline.

## Still Scoped

### Kling VIDEO 3.0 Omni

Kling is strategically important because of long, multi-shot, character-aware
generation. Before implementation we should confirm:

- Official API host and auth shape for our account.
- Exact text-to-video and image/reference-video endpoints for Kling 3.0 Omni.
- Whether references are single-image, multi-image, video, or character-profile
  resources.
- Polling/result download shape.
- Whether native audio should be requested or suppressed for Popcorn Ready's
  separate soundtrack pipeline.

Implementation shape should match the Runway/LTX provider contract:

- `provider: "kling"`
- `KLING_API_KEY` or whatever official auth requires
- text-to-video and image/reference-to-video
- async job polling
- output download to local storage

### Seedance 2.0

The cleanest first path is likely through Runway model selection, not a separate
provider:

- `provider: "runway"`
- `model: "<seedance model exposed by the workspace>"`

Reason:

- First-party global ByteDance/Dreamina API access and governance appear less
  settled than Runway's API surface.
- Runway already exposes task polling, output download, and API-key semantics we
  can support with the current provider abstraction.

If a direct Seedance enterprise API becomes available to this project, add it as
`provider: "seedance"` with the same `GenerateAssetRequest` contract.

### Wan 2.1 VACE

Wan 2.1 VACE is open/self-hosted rather than a simple hosted API integration.
The likely production path is a local or hosted worker, not a direct SaaS
provider call:

- Dedicated worker service with GPU scheduling.
- Input asset staging.
- Job polling and cancellation.
- Output upload back into Popcorn Ready storage.
- Separate config for model checkpoint, resolution, and task type.

Suggested provider key:

- `wan`

Do not add this as a synchronous Next.js route call. The model runtime and job
duration need the async jobs pipeline.

## Routing Recommendation

Default one-shot video provider should remain Gemini/Veo for now:

1. `gemini`
2. fallback `openai`
3. explicit opt-in to `runway` or `ltx`

Reason:

- Gemini is already proven locally.
- Runway and LTX require new keys and account-specific model access.
- LTX can be especially useful for lower-cost iteration, but its minimum
  supported durations differ from Gemini/OpenAI.

## Manual Test Plan

Run through `/api/generate-assets`:

```json
{
  "kind": "video",
  "provider": "runway",
  "model": "gen4.5",
  "prompt": "A cinematic shot of a young filmmaker opening a laptop at night.",
  "seconds": 5,
  "size": "1280x720"
}
```

```json
{
  "kind": "video",
  "provider": "ltx",
  "model": "ltx-2-3-fast",
  "prompt": "A cinematic shot of a young filmmaker opening a laptop at night.",
  "seconds": 6,
  "size": "1280x720"
}
```

For character consistency, first generate or select an image asset and pass it
as a reference clip. Runway and LTX both route local image references into
image-to-video requests.
