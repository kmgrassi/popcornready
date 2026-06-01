# Popcorn Ready — agent guide

AI-native video studio. The product never touches raw video — agents produce and
edit a **structured timeline**, and rendering is deterministic.

## Read this first

**[docs/NORTH_STAR.md](docs/NORTH_STAR.md)** is the authoritative vision for how
video generation should evolve: **one agent-orchestrated, non-one-directional
pipeline** where stages are tools the agent calls, runs are autonomous by
default, any stage can be re-triggered, and changes recompute only the affected
assets via a dependency/provenance graph. Align new generation work to it; flag
deviations explicitly. Do **not** entrench the old forward-only "edit the
timeline with patches" model.

## Where things live

- Live generation: `src/app/api/oneshot/` (sync) + `src/lib/runs/execute.ts`.
- Versioned/job stack: `src/lib/v1/`, `src/lib/api/v1/`, `src/app/api/v1/`.
- The agent (LLM) functions: `src/lib/agent/` (`planEdit`, `critiquePlan`,
  `critique`, `revise`, …). Generation/keyframes: `src/lib/generative/`.
- Core types: `src/lib/types.ts`. Edit graph: `src/lib/edit-graph.ts`.
- Scopes & design docs: `docs/scopes/`, `docs/research/`.

## Conventions

- Run the dev server with `NODE_ENV=development` (a stray `NODE_ENV=test` makes
  Next skip `.env.local` and drop API keys).
- Character/keyframe images of minors must use Gemini (OpenAI image-edit rejects
  editing photorealistic minors).
