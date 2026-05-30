# [![Popcorn Ready](./public/logo.svg)](https://popcornready.ai)

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

## Productionization docs

- [`docs/productionization-scope.md`](docs/productionization-scope.md)
- [`docs/railway-deployment.md`](docs/railway-deployment.md)
- [`docs/streaming-generation-plan.md`](docs/streaming-generation-plan.md)

Railway configuration is in `railway.toml`; healthcheck is `/api/v1/health`.

## Project layout

```
src/
  app/                Next.js App Router (page + API routes)
    api/{project,upload,generate,generate-assets,revise,export}/route.ts
  components/         Editor + Preview (Remotion Player)
  lib/
    agent/            planEdit / selectClips / critique / revise + JSON schemas
    anthropic.ts      Claude client + structured JSON call helper
    timeline.ts       Patch engine + prompt formatting
    types.ts          Timeline / Plan / Patch / Clip types
    store.ts          JSON-file project store
    generative/       Provider abstraction + OpenAI and Gemini adapters
  remotion/           VideoComposition + registered root for render/preview
```
