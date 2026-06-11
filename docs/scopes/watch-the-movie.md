# Watch the movie — scope & PR plan

## Goal

There is **no way to view a finished movie**. The poster grid invites a click,
but the click can only land on the storyboard. Three gaps stack up:

1. **Nothing produces a final video in the new stack.** `export` is defined in
   `GenerationStageType` (order 7) and `export_video` exists in the story-flow
   tool list, but `runGenerationJob` never executes either; the Remotion
   composition in `packages/renderer/` is never invoked by the v1 executor.
2. **The Outputs tab reads a legacy store.** `listWorkspaceOutputs()`
   (`apps/api/src/lib/api/v1/store.ts`) maps artifacts from `agentApiStore` —
   the `.local/agent-jobs.json` file store — not asset-graph `render` assets.
   Under the Supabase backend it is permanently empty.
3. **No watch surface.** No `/projects/:id/watch` route, no player page; the
   only `<video>` tag in the SPA is the small inline preview inside the Outputs
   card (`DashboardCollectionsPage.tsx` `OutputsPage`).

This scope produces `render` assets in the asset graph, projects a watch
payload from graph state, adds a watch page, and points the poster grid at it.

## Where "the movie" lives (target model — already in the schema)

No new tables. The asset graph migration (`20260610120000_asset_graph_model.sql`)
already defines everything:

- **The cut** is a `kind='composite'` asset — an ordered stitch of children via
  `child` edges — and the **project-scoped `cut` selection slot** (the schema
  comment names `'plan', 'cut'` as the project-scoped slots) points at the
  active one.
- **A render** is a `kind='render'` asset (`media='video'`): a deterministic
  encode of a composite, with an `input` edge to the composite it encodes.
  Re-rendering after an edit is a new render version; the composite's
  `content_hash` in the edge snapshot is the staleness signal.
- **The watch payload is a projection**, exactly like `posterUrl`: resolve the
  `cut` slot → newest ready `render` whose input is that composite lineage →
  signed URL. Per the Asset-Graph Migration Rule, the legacy
  `agentApiStore` artifacts must be retired, not bridged.

## What already exists (reuse — do NOT reinvent)

- **Timeline/assembly** — `apps/api/src/lib/v1/assemble.ts` and the
  `timeline_assembly` stage in `runGenerationJob` already pick ordered clips;
  `apps/api/src/lib/api/v1/asset-graph.ts` has the edge helpers for writing a
  composite with ordered `child` edges.
- **Remotion renderer** — `packages/renderer/src/` (`Root.tsx`,
  `VideoComposition.tsx`) renders a timeline; unwired but real.
- **Storage + signed URLs** — `apps/api/src/lib/supabase/storage.ts`:
  `uploadAssetObject()`, `createSignedAssetUrl(path, expiresInSec)` — works for
  video; Supabase storage serves range requests on signed URLs, which
  `<video>` seeking needs.
- **Poster projection pattern** — `projectProjection()` in
  `apps/api/src/lib/api/v1/store.ts` is the template for the watch projection
  (selection → asset → signed URL), and `posterUrl` is the natural
  `<video poster>` and card-art for the watch page.
- **Outputs UI shell** — `OutputsPage` in
  `apps/web/src/routes/DashboardCollectionsPage.tsx` already renders
  `<video controls poster={thumbnailUrl}>` per output; only its data source is
  wrong.

## What must be built

- **Render execution.** Stitch the active clips of the cut composite into one
  mp4. Decision: **ffmpeg concat for v1** (deterministic, cheap, matches
  "rendering is deterministic" in NORTH_STAR); Remotion becomes the upgrade
  path when we want title cards, transitions, and poster-text overlays.
  ffmpeg must be present on Railway (nixpacks package) and locally.
- **Render write path.** Download child clip bytes → concat → upload to
  `generated/{ws}/{project}/render-*.mp4` → insert `kind='render'` asset with
  an `input` edge to the composite + an `export_video` action.
- **Composite write on assembly.** `timeline_assembly` must persist its result
  as a `composite` asset + `cut` selection (if the media-stages scope hasn't
  landed this yet, it belongs here — the watch path needs a cut to render).
- **Watch projection + endpoint.** `GET /api/v1/projects/:projectId/watch` →
  `{ status: 'none'|'rendering'|'ready', renderAssetId, renderUrl, durationSec,
  posterUrl, renderedAt }`. Also a boolean (`hasRender`) on `V1Project` so the
  grid knows where a poster click should land.
- **Watch page.** `/projects/:projectId/watch` in `apps/web` — full-bleed
  `<video controls poster={posterUrl}>`, title, duration, "re-export" later.
- **Outputs tab re-point.** `listWorkspaceOutputs` reads `kind='render'`
  assets (project join + signed URLs); delete the `agentApiStore` artifact
  read per the no-legacy-bridges rule.

## PRs

### PR W1 — composite + render write path (no executor yet)

- **Files:** `apps/api/src/lib/api/v1/store.ts`,
  `apps/api/src/lib/api/v1/asset-graph.ts`, tests.
- **Work:** helpers to persist a composite (ordered child edges) + set the
  `cut` selection, and to insert a `render` asset from uploaded bytes with its
  `input` edge and `export_video` action.
- **Done when:** a unit-tested path takes clip asset ids → composite row +
  `cut` selection → render row with correct edges.

### PR W2 — ffmpeg export executor *(after W1)*

- **Files:** `apps/api/src/lib/generative/render.ts` (new),
  `apps/api/src/lib/v1/generation.ts`, Railway build config.
- **Work:** `renderComposite(compositeId)` — download children via
  `downloadAssetObjectToTemp`, ffmpeg concat (+ soundtrack track if present),
  upload, W1 write path. Wire as the `export` stage / `export_video` tool in
  `runGenerationJob`, fingerprint-gated like every stage.
- **Done when:** a run with clips ends `ready` with a playable mp4 render
  asset in storage; re-running without timeline changes skips the encode.

### PR W3 — watch projection + endpoint *(after W1, parallel with W2)*

- **Files:** `apps/api/src/lib/api/v1/store.ts`,
  `apps/api/src/routes/v1/projects.ts`, `packages/shared/src/v1/types.ts`.
- **Work:** cut→render resolution + signed URL (long TTL, e.g. 6h, minted per
  request); `hasRender` on `V1Project`.
- **Done when:** the endpoint returns a playable URL for a project with a
  render (W1 fixture is enough) and `status:'none'` otherwise.

### PR W4 — watch page + poster click-through *(after W3)*

- **Files:** `apps/web/src/App.tsx`, `apps/web/src/routes/WatchPage.tsx`
  (new), `apps/web/src/routes/DashboardCollectionsPage.tsx`,
  `apps/web/src/lib/api-client.ts`.
- **Work:** watch route + player page; poster cards link to `/watch` when
  `hasRender`, storyboard otherwise.
- **Done when:** clicking a poster on a rendered project plays the movie with
  the poster as the loading frame.

### PR W5 — Outputs tab on render assets *(after W1, independent of W2-W4)*

- **Files:** `apps/api/src/lib/api/v1/store.ts`, route + tests.
- **Work:** re-point `listWorkspaceOutputs` at `kind='render'` assets with
  signed URLs; remove the `agentApiStore` artifact dependency.
- **Done when:** Outputs lists supabase-backed renders and plays them inline;
  no code path reads `agent-jobs.json` for outputs.

## Dependency graph

```
W1 ──→ W2 (executor)
 ├───→ W3 (projection) ──→ W4 (watch page)
 └───→ W5 (outputs tab)        W2 ∥ W3 ∥ W5
```

## Risks / decisions

- **ffmpeg vs Remotion:** ffmpeg concat can't do transitions/title overlays;
  accepted for v1. Remotion swap-in is isolated behind `renderComposite()`.
- **Signed-URL expiry mid-playback:** mint per page load with a long TTL;
  the player refetches the projection on error as a fallback.
- **Audio mix:** v1 keeps per-clip audio + optional single soundtrack track;
  proper mixing belongs to the `audio_generation` work in
  `docs/scopes/generation-engine-media-stages-prs.md`.
- **Streaming scale:** signed Supabase URLs are fine for dev/small scale; the
  harper-medical S3+CloudFront layer is the known upgrade path when posters
  and renders need CDN delivery.
