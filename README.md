# aividi — AI-native video editor (MVP)

An MVP of the "core timeline loop" from the AI-native video editing architecture:

> Upload clips → give a goal/script → Claude generates an editable **timeline**
> → a critic loop improves it → revise it conversationally → preview in the
> browser → export an MP4.

The guiding principle from the architecture: **the AI never touches raw video.**
It only plans and edits a structured **timeline** (`src/lib/types.ts`). Rendering
is deterministic from that timeline via Remotion.

## How it works

```
goal + clips
   │
   ▼
planEdit()      goal → beats              (Claude, structured JSON)
   ▼
selectClips()   beats + clips → timeline  (Claude, structured JSON)
   ▼
critique()      timeline → scores + patches → applied  (Claude)
   ▼
revise()        chat message → patches → applied        (Claude)
   ▼
Remotion        timeline → <Player> preview + MP4 export
```

- **Agents** live in `src/lib/agent/`. Each is one structured Claude call using
  `output_config.format` (JSON schema) on `claude-opus-4-7`, with the stable
  instructions + clip catalog placed in a cached system block.
- **Timeline patches** (`src/lib/timeline.ts`) are validated and clamped before
  they touch the timeline, so a bad suggestion can't break rendering.
- **Rendering** (`src/remotion/`) is shared between the live `@remotion/player`
  preview and the server-side `renderMedia` MP4 export.
- **Generative asset fill** (`src/lib/generative/`) can add missing image or
  video assets to the clip library through a provider abstraction. OpenAI
  supports image and video generation; Gemini supports video generation through
  Veo 3.1; ElevenLabs supports generated audio helpers for speech, dialogue,
  sound effects, and music; NanoBanano is registered as an explicit placeholder
  for a future adapter.
- **Story context** (`src/lib/story-context.ts`) adds reusable science-video
  storytelling guidance from `docs/research/science-video-story-context.md` so
  the planner optimizes for hook, visual surprise, one big idea, simple model,
  caveat, and payoff.
- **Storage** is an MVP single-project JSON file in `data/`; uploaded clips go
  to `public/uploads/`, and generated assets go to `public/generated/`.

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

The MVP cleanup and production feature roadmap lives in
[`docs/productionization-scope.md`](docs/productionization-scope.md), with
focused scoping docs for browser upload/context workflows and agent-facing APIs.

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
    timeline.ts       patch engine + prompt formatting
    types.ts          Timeline / Plan / Patch / Clip types
    store.ts          JSON-file project store
    generative/       Provider abstraction + OpenAI and Gemini adapters
  remotion/           VideoComposition + registered root for render/preview
```
