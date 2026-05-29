# Aividi Productionization Scope

This document scopes the work needed to turn the current MVP into a reliable
video editing product and agent-operable API. The MVP proves the core loop:
upload clips, provide editorial intent, generate a structured timeline, revise
it, preview it, and export a deterministic MP4. Productionization should keep
that architecture: agents plan and patch structured data; rendering remains
deterministic and inspectable.

## North Star

Aividi should become the AI-native production studio where users and agents turn
raw or generated media into finished cinematic videos through structured intent,
editable timelines, and deterministic rendering.

The product should act as the system of record and control plane for
AI-assisted video production. External APIs can generate, analyze, or transform
media, but Aividi owns the project model, creative brief, asset context,
timeline structure, revision history, validation, rendering, exports, feedback,
and operational reliability.

The durable product principle is:

> AI plans and patches structured timelines; Aividi validates, versions,
> renders, learns from feedback, and stores the result.

The first production target is a reliable workflow where a browser user or
external agent can produce a finished short video from mixed uploaded and
generated assets, revise it without losing prior work, export it, and use
review feedback to improve future generations.

## Product Goals

- Make video upload, context entry, timeline generation, review, revision, and
  export usable by non-technical operators from the browser.
- Make the same workflow available to external agents through stable,
  documented APIs.
- Support multiple users and workspaces from day one, with the browser app and
  external agents sharing the same authorization model.
- Preserve deterministic rendering and patch validation so model output cannot
  corrupt projects or reference invalid media.
- Support multiple projects, multiple source assets, repeatable jobs, and
  durable outputs.
- Establish a foundation for richer media analysis without requiring it for the
  first production version.
- Establish an OODA feedback loop so user, reviewer, and operational feedback
  can improve future generated videos through explicit context, configuration,
  prompt, and service changes.

## Current MVP Gaps

- Single project stored in `data/project.json`; no project isolation, auth,
  audit log, or concurrent write safety.
- Upload metadata is thin: filename, description, duration, and URL.
- The UI does not guide users through structured context capture, asset review,
  or clip readiness checks.
- Feedback from generated videos is not captured as structured data, evaluated
  for actionability, or used to improve future generation behavior.
- API routes are browser-oriented and synchronous; long-running generation and
  export should become jobs with idempotency and status polling.
- Export depends on local public file storage and a running Next server.
- Validation exists for timeline patches, but request/response schemas are not
  versioned for external clients.
- There are no integration tests for upload, generate, revise, export, or API
  error behavior.

## Architecture Direction

- Move from the current single Next.js MVP into the same shape as the Parallel
  Agent platform: a Vite-style React browser app, an Express API server, and
  Supabase for user authentication.
- Use a monorepo layout with `apps/` for runnable applications and `packages/`
  for shared code. The first applications are `apps/web` and `apps/api`.
- Treat `/api/v1` as the product contract. The browser UI should use the same
  API shape that agent clients use where practical.
- Use Supabase auth for hosted and shared environments. The Express server
  verifies Supabase JWTs, resolves workspace membership, and authorizes every
  project-scoped request.
- Reuse the Parallel Agent platform Supabase env contract and point at the dev
  environment for the Harper database initially.
- Support a fully local development mode with auth disabled and local file
  storage backed by simple JSON files and local media directories. Local mode
  should create a deterministic development user/workspace context so browser
  and agent workflows can run without Supabase.
- Run jobs locally in the API process for v1. If the app gets meaningful
  adoption, split jobs into a separate worker process without changing the job
  API contract.
- Treat feedback as a first-class input to future generation. The system should
  capture feedback, classify whether it is actionable, decide what context or
  system behavior should change, and apply approved updates through controlled
  project, workspace, or service-level changes.
- In hosted environments, users self-create their first workspace after
  Supabase sign-up. Production should use Postgres-backed project data and
  object storage for media/artifacts.

## Scoping Documents

- [Auth And App Architecture](./scopes/auth-app-architecture.md)
- [Repo Architecture](./scopes/repo-architecture.md)
- [UI Video Upload](./scopes/ui-video-upload.md)
- [UI Video Context](./scopes/ui-video-context.md)
- [Agent API](./scopes/agent-api.md)
- [Agent Video Generation API](./scopes/agent-video-generation-api.md)
- [API Contract V1](./scopes/api-contract-v1.md)
- [Project Model And Storage](./scopes/project-model-storage.md)
- [Jobs And Processing](./scopes/jobs-processing.md)
- [OODA Feedback Loop](./scopes/ooda-feedback-loop.md)
- [Character Consistency Generation](./scopes/character-consistency-generation.md)
- [Quality, Safety, And Observability](./scopes/quality-safety-observability.md)

## Recommended Phases

### Phase 1: Stabilize The MVP

- Split toward the target app shape: Vite-style React UI client, Express API
  boundary, and shared TypeScript schemas.
- Adopt the monorepo target layout: `apps/web`, `apps/api`, and shared packages.
- Add Supabase-auth-aware request context with an explicit local auth bypass for
  development.
- Add project IDs and route all API actions through project-scoped storage.
- Move request validation into shared schemas for UI and API routes.
- Make upload duration extraction server-side instead of trusting form input.
- Add clear UI states for upload progress, generation progress, export progress,
  validation errors, and retryable failures.
- Add lightweight structured feedback capture on exported videos and generated
  timelines so reviewers can record what worked, what failed, and what should be
  different next time.
- Add smoke tests for upload, generate, revise, and export using small fixture
  videos.

### Phase 2: Structured Context And Agent API

- Introduce project-level brief fields: goal, audience, platform, aspect ratio,
  tone, must-use clips, avoid-list, brand voice, CTA, and target duration.
- Introduce clip-level annotations: content summary, useful moments, people,
  product areas, transcript snippets, audio quality, visual quality, and usage
  restrictions.
- Add an agent-facing API for creating projects, uploading or registering video
  assets, attaching context, starting generation jobs, revising timelines, and
  exporting renders.
- Add idempotency keys and stable job IDs so agents can retry safely.
- Implement v1 jobs locally in the API process with persisted JSON job state.
- Keep agent API authentication bypassed in `AUTH_MODE=local` so local agents can
  automate the workflow without provisioning API keys.
- Use workspace-scoped API keys for v1 hosted agent access; OAuth-style external
  app authorization is out of scope for v1.
- Introduce Observe and Orient feedback agents that store reviewer feedback and
  classify whether it is actionable for a specific timeline, project brief,
  workspace preference, provider setting, prompt pattern, or service behavior.

### Phase 3: Durable Production System

- Replace local JSON and public file storage with a database and object storage.
- Add background workers for media ingest, analysis, generation, and rendering.
- Add signed upload/download URLs and retention policies.
- Add project history, timeline versions, generated variants, and export
  artifacts.
- Add role management, rate limits, quotas, audit trails, and admin visibility.
- Introduce Decide and Act feedback agents that propose approved updates to
  context, configuration, prompt templates, evaluation criteria, or code changes
  when repeated feedback shows the generation system should improve.

## Non-Goals For The First Production Pass

- Full nonlinear editor parity.
- Frame-accurate manual trimming UI beyond simple segment review and patching.
- Automatic video understanding as the only source of truth. Human-entered and
  agent-provided context should remain first-class even after analysis exists.
- Multi-user realtime collaboration.

## Definition Of Production Ready

- A user can create a project, upload several videos, add structured context,
  generate a cut, revise it, preview it, export it, and later reopen the project.
- An external agent can perform the same workflow through documented APIs with
  idempotent retries and job polling.
- Supabase-authenticated users can only access projects in their workspaces,
  while local development can run without Supabase through a deliberate dev-only
  identity mode.
- Invalid model output, invalid client input, missing media, and failed renders
  produce typed errors instead of corrupting project state.
- Every generated timeline is traceable to source assets, prompt/context inputs,
  model settings, and applied patches.
- The system has test coverage for the critical workflow and enough logging to
  diagnose failed jobs without exposing secrets or raw customer content.
