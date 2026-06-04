# API v1 Misc Capabilities

PR A7 folds the remaining non-v1 browser capabilities into v1 resources without
preserving the old `/api/*` paths.

## Carried Forward

- `POST /api/v1/projects/:projectId/uploads` registers uploaded/imported media
  as v1 assets. The endpoint accepts the existing v1 asset registration JSON
  shape (`source`, `kind`, `filename`, `durationSec`, `context`,
  `userContext`, `agentContext`) and creates an `asset_ingest` job.
- `GET|POST /api/v1/projects/:projectId/compositions` and
  `GET /api/v1/projects/:projectId/compositions/:compositionId` persist
  composition plans and their composition jobs.
- `GET|POST /api/v1/projects/:projectId/characters`,
  `PATCH /api/v1/projects/:projectId/characters/:characterId`, and
  `POST /api/v1/projects/:projectId/characters/:characterId/references`
  model characters as `character_reference` / `character_anchor` asset context.
- `PATCH /api/v1/projects/:projectId/assets/:assetId/character-review` records
  generated-asset character review results on the asset's v1 context.
- `GET|POST /api/v1/projects/:projectId/exports` and
  `GET /api/v1/projects/:projectId/exports/:jobId` create and read export jobs.
  Timeline-specific rendering remains aligned with the nested timeline export
  resource.
- `POST /api/v1/projects/:projectId/audio-alignments` and
  `GET /api/v1/projects/:projectId/audio-alignments/:jobId` create and read
  audio-alignment jobs.

## Dropped

- `debug/**` endpoints are not carried forward into v1. They were development
  probes for provider behavior and should be replaced by tests or operator-only
  scripts when still useful.
- The old root-level `/api/export`, `/api/exports`, `/api/upload`,
  `/api/compositions`, `/api/characters`, `/api/align-audio`, and
  `/api/assets/:assetId/character-review` paths are intentionally not mounted.
