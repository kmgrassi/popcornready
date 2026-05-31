<p align="left">
  <a href="https://popcornready.ai">
    <img src="./public/brand/popcorn-ready-logo.svg" alt="Popcorn Ready logo" width="140" />
  </a>
</p>

**Popcorn Ready** is an AI-native video editor that turns clips and your brief into an editable timeline quickly.

- **Upload media and descriptions**
- **Generate a rough cut automatically**
- **Revise with chat**
- **Preview in-browser and export MP4**

🌐 **Website:** https://popcornready.ai

## What it is

Popcorn Ready is a content production workflow:

1. Upload your video and image assets with short descriptions.
2. Give the app a creative goal, target length, and style.
3. Generate a first-pass timeline and a critic response.
4. Refine the cut with conversational prompts.
5. Preview in Remotion and export to MP4.

The editor never directly manipulates raw footage. It plans and patches a
structured timeline model (`src/lib/types.ts`) and then renders it deterministically.

- Timeline changes are generated as validated patches.
- Asset metadata and generated media are organized per project store.
- Rendering is reproducible across preview and export.

## Features

- **Structured pipeline**
  - `planEdit`, `selectClips`, `critique`, and `revise` run through stable JSON
    contracts.
- **AI review loop**
  - Timeline suggestions are scored and patched before final playback.
- **Interactive revision**
  - Ask for changes in plain language and apply targeted patch updates.
- **Generative fallback assets**
  - Missing visuals can be auto-generated from provider integrations.
- **Export-ready output**
  - In-browser preview and MP4 export are part of the same timeline pipeline.

## Who it is for

- Marketers and creators iterating quickly on short-form campaigns.
- Product teams creating consistent brand motion content.
- Creators wanting a fast first draft before manual finishing.

## Typical flow

1. Upload media assets.
2. Add short descriptions for each asset.
3. Use **Generate missing asset** for any gaps.
4. Set length/aspect/style, then click **Generate rough cut**.
5. Inspect the plan, timeline, and critic scores.
6. Revise with commands like:
   - make it punchier
   - shorten to 15s
   - add captions
   - use less talking head
7. Export MP4.

## Setup

```bash
cp .env.local.example .env.local   # add provider keys as needed
npm install
npm run dev
```

Open http://localhost:3000

The home page (`/`) is the marketing landing page: it explains the product, lets
you create a 30-second video from a single prompt (with template chips to start
from), lists hosted pricing, and links to GitHub for self-hosting. Submitting the
prompt opens the studio (`/studio`) and **one-shots** the video: it plans beats,
generates a visual for each beat, and cuts a timeline — no uploads required.

By default the one-shot generates a real **video clip per beat** (OpenAI Sora
when `OPENAI_API_KEY` is set, Gemini Veo when `GEMINI_API_KEY` is set), so you
get an actual moving 30-second video. This is expensive, so it is gated by a kill
switch: set `ONESHOT_VIDEO=off` to fall back to fast still-frame generation under
load. With no video-capable key it uses still images (real with `OPENAI_API_KEY`,
placeholder frames without) so the flow always completes. You can also go
straight to `/studio` to bring your own clips with the full editor below.

1. Upload a handful of video or image assets. Add a short description for each —
   in this MVP the AI reasons over the **filename + your description + duration** (real
   transcription/vision analysis is the documented next step, not in this slice).
2. If the library is missing a visual, use **Generate missing asset** to create
   an image or short video asset. OpenAI is live when `OPENAI_API_KEY` is set;
   Gemini video generation is live when `GEMINI_API_KEY` is set. ElevenLabs
   audio generation is live when `ELEVENLABS_API_KEY` is set.
3. Write a creative goal, set length/aspect/style, and **Generate rough cut**.
4. Inspect the plan, timeline, and critic scores; preview plays in the browser.
5. **Revise (chat)**: "make it punchier", "shorten to 15s", "add captions",
   "use less talking head". Each message is turned into timeline patches.
6. **Export MP4**: renders the real cut of your clips via Remotion. The first
   export downloads a headless browser, so it takes a bit longer.

## Scope / limitations (deliberate, for the MVP)

- Clip understanding is description-based — no FFmpeg proxies, Whisper
  transcription, vision tagging, or embeddings yet (those are the "real
  analysis" extension from the architecture doc).
- Single project, file-based store (no Postgres/pgvector, no auth, no queue).
- Critic runs one pass on generate; the full critique→re-render loop and
  multiple rough-cut variants are future work.
- Gemini image generation and NanoBanano provider adapters are placeholders in
  this pass.
- Generated audio is saved as an asset but is not yet mixed into exported
  timelines. Audio clips are excluded from visual clip selection prompts.
- MP4 export requires the dev server running (Remotion fetches the uploaded
  clips over `http://localhost:3000`).

## Productionization docs

- [`docs/productionization-scope.md`](docs/productionization-scope.md)
- [`docs/railway-deployment.md`](docs/railway-deployment.md)
- [`docs/streaming-generation-plan.md`](docs/streaming-generation-plan.md)

Railway configuration is in `railway.toml`; healthcheck is `/api/v1/health`.

## Deploy to Railway

Railway deployment notes live in
[`docs/railway-deployment.md`](docs/railway-deployment.md). The repo includes a
`railway.toml` that uses Railpack, runs `npm run build`, starts the service with
`npm run start`, and healthchecks `/api/v1/health`.

Set the provider keys from `.env.local.example` as Railway service variables.
For a hosted demo, be aware that the current MVP stores project state and media
on the local filesystem; see the Railway deployment doc for the persistence
limitations and production storage recommendations.

## Project layout

```
src/
  app/                Next.js App Router (landing + studio + API routes)
    page.tsx          marketing landing page (/)
    studio/page.tsx   the editor (/studio); ?goal=&length=&autostart=1 one-shots
    api/{project,upload,generate,oneshot,generate-assets,revise,export}/route.ts
  components/         Editor (UI) + Preview (Remotion Player)
  lib/
    agent/            planEdit / selectClips / critique / revise + JSON schemas
    anthropic.ts      Claude client + structured JSON call helper
    timeline.ts       Patch engine + prompt formatting
    types.ts          Timeline / Plan / Patch / Clip types
    store.ts          JSON-file project store
    generative/       Provider abstraction + OpenAI and Gemini adapters
  remotion/           VideoComposition + registered root for render/preview
```
