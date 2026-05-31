# OODA Feedback Loop Scope

## Objective

Create a feedback system that helps Popcorn Ready improve future video generation over
time. Feedback from a generated video should become structured knowledge that can
influence later briefs, asset context, prompt patterns, provider settings,
quality checks, or service code through a controlled Observe, Orient, Decide,
Act loop.

The loop should not let arbitrary feedback directly mutate production behavior.
Each step should preserve provenance, classify confidence, and make the proposed
change reviewable before it affects future videos.

## Product Principle

Popcorn Ready should learn from every reviewed output without losing deterministic,
inspectable project state. Feedback becomes another first-class project input,
alongside source assets, generated assets, briefs, timeline versions, model
settings, patches, and exports.

## Loop Stages

### Observe

The Observe agent captures feedback and stores it with enough context to be
useful later.

Inputs:

- User or reviewer notes on a timeline, export, asset, segment, caption, or
  generated output.
- Structured ratings such as hook quality, pacing, clarity, visual consistency,
  brand fit, factual accuracy, emotional arc, and constraint compliance.
- Operational signals such as failed jobs, provider errors, retry counts, render
  failures, or frequent manual revisions.
- Optional agent-generated critiques from existing quality reports.

Outputs:

- `FeedbackEvent` records linked to workspace, project, timeline, export,
  asset, segment, job, model settings, and prompt/context inputs where known.
- Raw reviewer text preserved as user input, plus normalized metadata for
  querying and aggregation.
- Audit events for feedback creation and source.

### Orient

The Orient agent evaluates whether feedback is actionable and where it applies.

Responsibilities:

- Classify feedback as actionable, non-actionable, duplicate, preference,
  defect, safety issue, provider limitation, context gap, prompt gap, or product
  feature request.
- Identify scope: segment, timeline, project, workspace, provider, prompt
  template, evaluation rubric, code path, or documentation.
- Separate one-off creative preference from repeated system behavior.
- Attach confidence and evidence, including related feedback and affected
  outputs.

Outputs:

- `FeedbackInsight` records with actionability, category, scope, confidence,
  supporting feedback IDs, and recommended next step.
- Safety or quality escalations when feedback indicates a high-risk failure.

### Decide

The Decide agent determines whether the system should update context or behavior.

Responsibilities:

- Decide whether to ignore, monitor, ask for clarification, update project
  context, update workspace preferences, tune generation configuration, adjust a
  prompt/evaluation template, or propose a code change.
- Prefer narrow updates first. A single project's creative note should not
  become a global rule unless repeated evidence supports it.
- Require explicit human approval for global prompt, config, provider, safety,
  or code changes.
- Produce a concrete proposed change with expected impact and rollback path.

Outputs:

- `FeedbackDecision` records with status, proposed action, target scope,
  approval requirement, rationale, and linked insights.
- Optional follow-up jobs, such as regenerating a timeline variant using updated
  context.

### Act

The Act agent applies approved decisions through safe, auditable mechanisms.

Allowed actions:

- Update project brief or clip context.
- Update workspace-level creative preferences or brand constraints.
- Update generation configuration, such as provider choice, default duration,
  aspect ratio preference, quality thresholds, or retry policy.
- Update prompt templates or evaluation rubrics through versioned config.
- Open a code-change proposal when feedback points to a service bug, missing
  feature, broken validation rule, or repeatable quality failure that cannot be
  solved with context or config.

Guardrails:

- Every Act operation creates an audit event and records the decision that
  authorized it.
- Global service behavior changes require human approval before activation.
- Code changes are proposed as reviewable diffs or issues, not silently applied
  to production.
- Act should never mutate historical timelines or exports. It creates new
  context versions, config versions, prompt versions, or follow-up jobs.

## Required Entities

- `FeedbackEvent`: raw and structured feedback attached to a project artifact or
  operational event.
- `FeedbackInsight`: Orient-stage classification with actionability, category,
  scope, confidence, and evidence.
- `FeedbackDecision`: Decide-stage proposed action, target, status, rationale,
  approval requirement, and linked insights.
- `FeedbackAction`: Act-stage record of the applied change, resulting version,
  audit event, and rollback pointer where applicable.
- `WorkspacePreference`: durable workspace-level learning, such as brand voice,
  recurring avoid-list, pacing preference, or platform-specific defaults.
- `PromptConfigVersion`: versioned prompt, rubric, or generation policy used by
  future jobs.

## API Requirements

- `POST /api/v1/projects/:projectId/feedback`
- `GET /api/v1/projects/:projectId/feedback`
- `POST /api/v1/projects/:projectId/feedback/:feedbackId/orient`
- `GET /api/v1/projects/:projectId/feedback-insights`
- `POST /api/v1/projects/:projectId/feedback-insights/:insightId/decisions`
- `POST /api/v1/feedback-decisions/:decisionId/approve`
- `POST /api/v1/feedback-decisions/:decisionId/act`

For v1, Orient, Decide, and Act can run as jobs using the same job model as
generation, revision, and export. Hosted production should support approval and
audit flows before workspace or global behavior changes are activated.

## UI Requirements

- Allow reviewers to leave structured and freeform feedback on exports,
  timelines, assets, and individual segments.
- Show whether feedback has been oriented, marked actionable, converted into a
  decision, or applied.
- Show proposed context, config, prompt, or code changes before approval.
- Make the scope of a proposed change obvious: project-only, workspace-level, or
  global service behavior.

## Phase Placement

Phase 1 should add simple feedback capture and storage so exported videos can be
reviewed without losing learning signals.

Phase 2 should add Observe and Orient agents so feedback becomes classified,
searchable, and tied to generation context.

Phase 3 should add Decide and Act agents with approval workflows, audit events,
and versioned updates to workspace preferences, prompt/config versions, and
follow-up jobs.

Global self-improvement through code changes should remain gated by human review
and normal pull request workflow.

## Acceptance Criteria

- A reviewer can attach feedback to a generated timeline or export.
- Feedback records preserve source artifact, timeline, prompt/context, model,
  and job provenance where available.
- The Orient agent can classify feedback actionability and scope.
- The Decide agent can propose whether to update project context, workspace
  preferences, prompt/config versions, or code.
- The Act agent can apply approved project or workspace updates without
  mutating historical outputs.
- Global prompt, config, provider, safety, or code changes require explicit
  approval and leave an audit trail.
- Future generation jobs can reference applied feedback-derived context or
  config versions.
